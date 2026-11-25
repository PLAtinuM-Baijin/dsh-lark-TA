/**
 * 助教实例的 view_image 工具：按需把图片作为图片内容块交给多模态模型。
 *
 * 输入可以是工作区/课程目录里的图片，也可以是归档的 PPTX/DOCX 加 entry
 * （如 ppt/media/image12.png）。内嵌图第一次使用时才从压缩包里解出来，
 * 落到工作区 <归档名>.images/ 下复用；绝不预先全量解包。
 * 只把 PNG/JPEG/WebP/GIF 交给附件服务，图片大小与像素上限由附件服务兜底；
 * 当前模型不支持图片输入时明确报错，让模型退回 .txt 里的 OCR 结果。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import Schema from '@deepseek-ai/schemastery'
import { createPathScope } from './ta-fs-scope.js'

export const name = 'view-image'
export const inject = ['tools']

export const Config = Schema.object({
  readRoots: Schema.array(Schema.string()).default([]).description('只读根目录（课程目录等）'),
  writeRoot: Schema.string().default('').description('唯一可写的工作区根目录'),
  cacheDir: Schema.string().default('').description('内嵌图解包落盘目录；缺省用工作区根'),
  maxBytes: Schema.number().default(12 * 1024 * 1024).description('单张图片字节上限'),
  timeoutMs: Schema.number().default(20000).description('解包超时毫秒数'),
})

const ENTRY_PATTERN = /^(?:ppt|word)\/media\/[^/\\]+$/
const MAX_CHILD_BUFFER = 24 * 1024 * 1024
/** 子进程只拿最小环境，不继承 TA_APP_SECRET 等密钥。 */
const SAFE_ENV = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'Asia/Shanghai',
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },
    mediaType: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    bytes: { type: 'number' },
  },
  required: ['ok', 'path', 'mediaType', 'width', 'height', 'bytes'],
  additionalProperties: false,
}

const PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        '图片文件路径，或 PPTX/DOCX 归档路径。绝对路径，或相对工作区 files/ 的路径。',
    },
    entry: {
      type: 'string',
      description:
        '可选。PPTX/DOCX 内嵌图片的条目名，如 ppt/media/image12.png；' +
        '取图片文件本身时不要给。OCR 结果里会标图片名和页码。',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const scope = createPathScope(config)
  const cacheDir = path.resolve(config.cacheDir.trim() !== '' ? config.cacheDir.trim() : scope.writeRoot)
  const maxBytes = Number.isFinite(config.maxBytes) && config.maxBytes > 0 ? Math.trunc(config.maxBytes) : 12 * 1024 * 1024
  const timeout = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? Math.trunc(config.timeoutMs) : 20000
  /** execute 里异步存好的图片投影，交给同步的 projectContent 使用。 */
  const projections = new WeakMap()

  const tool = {
    name: 'view_image',
    description:
      '把图片原样交给模型直接查看（多模态），用于精确读公式、表格、版式，或用户要求看原图。' +
      'path 给图片文件或 PPTX/DOCX 归档路径；PPTX/DOCX 内嵌图片再给 entry（如 ppt/media/image12.png，' +
      'OCR 结果里标了图片名和页码）。首次调用会把内嵌图解到工作区 <归档名>.images/ 下，之后复用。' +
      '每张图消耗视觉 token，先用 .txt 里的 OCR 判断是否真的需要精读；模型不支持图片输入时本工具会报错，此时只能依赖 OCR。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderSummary },
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('view_image: 参数必须是对象')
      }
      const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
      if (rawPath === '' || rawPath.length > 1000 || rawPath.includes(String.fromCharCode(0))) {
        throw new Error('view_image: path 必须是长度合规的非空字符串')
      }
      const entry = args.entry === undefined ? '' : args.entry
      if (typeof entry !== 'string' || entry.length > 200) {
        throw new Error('view_image: entry 必须是字符串')
      }
      if (entry !== '' && !ENTRY_PATTERN.test(entry)) {
        throw new Error('view_image: entry 必须是 ppt/media/... 或 word/media/... 下的单个文件名')
      }
      if (exec.signal !== undefined && exec.signal.aborted) throw new Error('view_image: 调用已取消')

      const attachments = await resolveImageStore(ctx, exec)
      const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(cacheDir, rawPath)
      const source = await scope.resolveRead(absolute)
      const stat = await fs.stat(source)
      if (!stat.isFile()) throw new Error(`view_image: 不是普通文件：${absolute}`)

      let imagePath
      let buffer
      if (entry === '') {
        if (stat.size > maxBytes) throw new Error(`view_image: 图片超过 ${maxBytes} 字节上限`)
        imagePath = source
        buffer = await fs.readFile(source)
      } else {
        const extension = path.extname(source).toLowerCase()
        if (extension !== '.pptx' && extension !== '.docx') {
          throw new Error('view_image: 只有 PPTX/DOCX 需要给 entry，其它文件直接给 path')
        }
        const prefix = extension === '.pptx' ? 'ppt/media/' : 'word/media/'
        if (!entry.startsWith(prefix)) throw new Error(`view_image: ${extension} 的 entry 必须以 ${prefix} 开头`)
        const targetDir = path.join(cacheDir, `${path.basename(source)}.images`)
        const target = await scope.resolveWrite(path.join(targetDir, path.basename(entry)))
        const cached = await readCachedImage(target, maxBytes)
        if (cached === undefined) {
          buffer = await unzipEntry(source, entry, maxBytes, timeout)
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
          await fs.writeFile(target, buffer, { mode: 0o600 })
        } else {
          buffer = cached
        }
        imagePath = target
      }

      const mediaType = detectImageMedia(buffer)
      if (mediaType === undefined) throw new Error(`view_image: 不是 PNG/JPEG/WebP/GIF 图片：${imagePath}`)
      if (buffer.length > maxBytes) throw new Error(`view_image: 图片超过 ${maxBytes} 字节上限`)

      const refs = await attachments.saveImages([
        { data: buffer, mediaType, name: path.basename(imagePath) },
      ])
      const ref = refs[0]
      const value = {
        ok: true,
        path: imagePath,
        mediaType: ref.mediaType,
        width: ref.width,
        height: ref.height,
        bytes: ref.bytes,
      }
      projections.set(exec, {
        value,
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: summary(value) },
        ],
      })
      return value
    },
    projectContent(exec, result) {
      const projection = projections.get(exec)
      if (projection === undefined) return undefined
      projections.delete(exec)
      if (result.isError) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      return projection.content
    },
  }
  ctx.tools.register(tool)
}

function summary(value) {
  return `已加载图片：${value.path}（${value.mediaType}，${value.width}×${value.height}，${value.bytes} 字节）`
}

function renderSummary(_args, value) {
  return [{ type: 'text', text: summary(value) }]
}

/** 按 MCP 客户端的做法确认当前路由的模型声明了图片输入，再拿附件仓库。 */
async function resolveImageStore(ctx, exec) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('view_image: 当前进程没有挂载附件服务')
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('view_image: 无法确认当前模型路由')
  }
  let info
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('view_image: 无法确认当前模型是否支持图片输入')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`view_image: 当前模型（${model}）不支持图片输入，请改用 .txt 里的 OCR 结果`)
  }
  return attachments
}

/** 缓存文件存在、大小合规且确实是图片时才复用。 */
async function readCachedImage(target, maxBytes) {
  try {
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return undefined
    const buffer = await fs.readFile(target)
    return detectImageMedia(buffer) === undefined ? undefined : buffer
  } catch {
    return undefined
  }
}

function unzipEntry(archive, entry, maxBytes, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      'unzip',
      ['-p', archive, entry],
      { encoding: 'buffer', timeout, maxBuffer: MAX_CHILD_BUFFER, windowsHide: true, env: SAFE_ENV },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim().slice(0, 300) : ''
          if (error.code === 'ENOENT') reject(new Error('view_image: 服务器上没有 unzip 命令'))
          else if (error.killed) reject(new Error('view_image: 解包超时'))
          else reject(new Error(`view_image: 从压缩包里取 ${entry} 失败${detail === '' ? '' : `：${detail}`}`))
          return
        }
        const buffer = stdout
        if (buffer.length === 0) {
          reject(new Error(`view_image: 压缩包里没有 ${entry}，或条目是空文件`))
          return
        }
        if (buffer.length > maxBytes) {
          reject(new Error(`view_image: 图片超过 ${maxBytes} 字节上限`))
          return
        }
        resolve(buffer)
      },
    )
  })
}

function detectImageMedia(buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 6) {
    const magic = buffer.subarray(0, 6).toString('latin1')
    if (magic === 'GIF87a' || magic === 'GIF89a') return 'image/gif'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}
