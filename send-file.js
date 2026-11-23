/**
 * 出站媒体工具 feishu_send_file（助教版）。
 *
 * 挂在助教 preset，任何聊天会话都可以把工作区里的文件发到当前聊天：
 *   班级群、助教/老师小群、学生私聊都行；记忆整理会话与非法会话拒绝。
 * 路径必须落在 writeRoot（工作区）内，经 ta-fs-scope 的 realpath 包含检查，
 * 防止借发文件读取工作区之外的课程目录或服务器文件。
 *
 * 图片（≤10MB）走 im.image.create 上传，以 image 消息发出；
 * 其余文件（≤30MB）走 im.file.create，以 file 消息发出。
 * 上传失败降级只发生在图片上传阶段：图片格式不被接受时改按文件发送。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import Schema from '@deepseek-ai/schemastery'
import { createPathScope } from './ta-fs-scope.js'

export const name = 'feishu-send-file'
export const inject = ['tools']

export const Config = Schema.object({
  appId: Schema.string().description('飞书自建应用 App ID；缺省用 TA_APP_ID'),
  appSecret: Schema.string().description('飞书自建应用 App Secret；缺省用 TA_APP_SECRET'),
  writeRoot: Schema.string().description('唯一可发送的文件根目录（工作区）；缺省用 TA_WORKSPACE'),
  cwd: Schema.string().description('相对路径的解析基准；缺省用 TA_WORKSPACE'),
})

const CHAT_SESSION = /^feishu-(oc_[A-Za-z0-9]+)-\d{8}$/
/** 飞书图片消息上限 10MB；支持 JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO。 */
const IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024
/** 飞书文件消息上限 30MB。 */
const FILE_UPLOAD_LIMIT = 30 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.ico'])

const PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '工作区里的文件路径；优先绝对路径，~ 开头也可，相对路径按工作区解析。不要发工作区之外的文件。',
    },
    name: {
      type: 'string',
      description: '在飞书里显示的文件名；缺省用磁盘上的文件名。',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    kind: { type: 'string' },
    name: { type: 'string' },
    size: { type: 'integer' },
    chatId: { type: 'string' },
    messageId: { type: 'string' },
    fileKey: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['ok', 'message'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const appId = (config.appId ?? process.env.TA_APP_ID ?? '').trim()
  const appSecret = (config.appSecret ?? process.env.TA_APP_SECRET ?? '').trim()
  const cwd = (config.cwd ?? process.env.TA_WORKSPACE ?? '').trim()
  const writeRoot = (config.writeRoot ?? process.env.TA_WORKSPACE ?? '').trim()
  const scope = createPathScope({ writeRoot })
  const client = appId === '' || appSecret === '' ? undefined : new Lark.Client({ appId, appSecret })
  if (client === undefined) {
    console.warn('feishu-send-file: 缺少 TA_APP_ID / TA_APP_SECRET，feishu_send_file 会拒绝执行')
  }

  ctx.tools.register({
    name: 'feishu_send_file',
    description:
      '把工作区里的一个文件或图片发送到当前飞书聊天（群聊或私聊）。只能发工作区内的文件；图片≤10MB 直接显示，其他文件≤30MB 作为文件消息，均不支持空文件。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
    },
    async execute(args, exec) {
      return execute(args, exec, { client, scope, cwd })
    },
  })
}

async function execute(args, exec, options) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('feishu_send_file: 参数必须是对象')
  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  if (rawPath === '') throw new Error('feishu_send_file: 需要 path（工作区里的文件路径）')
  if (options.client === undefined) throw new Error('feishu_send_file: 插件缺少 TA_APP_ID / TA_APP_SECRET，无法发送')

  const chatId = sessionChatOf(exec)
  const path = await options.scope.resolveWrite(resolvePath(rawPath, options.cwd))
  const stat = await statFile(path)
  if (!stat.isFile()) throw new Error(`feishu_send_file: ${path} 不是普通文件`)
  if (stat.size === 0) throw new Error('feishu_send_file: 飞书不接受空文件')
  if (stat.size > FILE_UPLOAD_LIMIT) {
    throw new Error(`feishu_send_file: 文件 ${stat.size} 字节，超过飞书 30MB 上限`)
  }

  const shownName = displayName(args.name, basename(path))
  const isImage =
    stat.size <= IMAGE_UPLOAD_LIMIT &&
    (IMAGE_EXTENSIONS.has(extensionOf(path)) || (await looksLikeImage(path)))

  let note = ''
  if (isImage) {
    let imageKey
    try {
      imageKey = await uploadImage(options.client, path)
    } catch (error) {
      // 扩展名像图片但内容不被飞书接受时，退回文件发送。
      note = `图片上传失败（${errorMessage(error)}），已改为文件发送。`
    }
    if (imageKey !== undefined) {
      const messageId = await sendMessage(options.client, chatId, 'image', { image_key: imageKey })
      console.info(`feishu-send-file: sent image size=${stat.size} chat=${chatId}`)
      return success('image', shownName, stat.size, chatId, messageId, imageKey, note)
    }
  }

  const fileKey = await uploadFile(options.client, path, shownName)
  const messageId = await sendMessage(options.client, chatId, 'file', { file_key: fileKey })
  console.info(`feishu-send-file: sent file size=${stat.size} chat=${chatId}`)
  return success('file', shownName, stat.size, chatId, messageId, fileKey, note)
}

function sessionChatOf(exec) {
  const sessionId = exec.agent?.session?.id
  const match = typeof sessionId === 'string' ? CHAT_SESSION.exec(sessionId) : null
  if (match === null) throw new Error('feishu_send_file: 当前会话不是飞书聊天会话，不能发送文件')
  return match[1]
}

function resolvePath(rawPath, cwd) {
  const expanded = expandHome(rawPath)
  if (isAbsolute(expanded)) return expanded
  if (cwd !== '') return resolve(cwd, expanded)
  throw new Error('feishu_send_file: 请使用绝对路径（插件没有配置相对路径基准）')
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

async function statFile(path) {
  try {
    return await fsp.stat(path)
  } catch (error) {
    throw new Error(`feishu_send_file: 读不到 ${path}（${error?.code ?? String(error)}）`)
  }
}

function displayName(rawName, fallback) {
  const source = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : fallback
  const base = source.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '_')
    .trim()
  return cleaned === '' ? 'file' : cleaned.slice(0, 120)
}

async function looksLikeImage(path) {
  const handle = await fsp.open(path, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return isImageHead(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function isImageHead(head) {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true
  if (head.length >= 6) {
    const magic = head.subarray(0, 6).toString('latin1')
    if (magic === 'GIF87a' || magic === 'GIF89a') return true
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return true
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return true
  if (head.length >= 4) {
    const tiff =
      (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)
    if (tiff) return true
    if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return true
  }
  return false
}

async function uploadImage(client, path) {
  const res = await client.im.image.create({
    data: { image_type: 'message', image: fs.createReadStream(path) },
  })
  const imageKey = res?.image_key ?? res?.data?.image_key
  if (typeof imageKey !== 'string' || imageKey === '') throw new Error('飞书没有返回 image_key')
  return imageKey
}

async function uploadFile(client, path, name) {
  const res = await client.im.file.create({
    data: { file_type: 'stream', file_name: name, file: fs.createReadStream(path) },
  })
  const fileKey = res?.file_key ?? res?.data?.file_key
  if (typeof fileKey !== 'string' || fileKey === '') throw new Error('飞书没有返回 file_key')
  return fileKey
}

async function sendMessage(client, chatId, msgType, content) {
  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
  })
  if (res?.code !== undefined && res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`)
  const messageId = res?.data?.message_id
  if (typeof messageId !== 'string' || messageId === '') throw new Error('飞书没有返回 message_id')
  return messageId
}

function success(kind, name, size, chatId, messageId, fileKey, note) {
  const value = {
    ok: true,
    message: kind === 'image' ? `已发送图片「${name}」` : `已发送文件「${name}」`,
    kind,
    name,
    size,
    chatId,
    messageId,
    fileKey,
  }
  if (note !== '') {
    value.message = `${value.message}；${note}`
    value.note = note
  }
  return value
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function errorMessage(error) {
  const data = error?.response?.data
  if (data !== undefined && typeof data?.msg === 'string') return `${data.code ?? 'error'}: ${data.msg}`
  return error instanceof Error ? error.message : String(error)
}

function renderResult(_args, value) {
  return [{ type: 'text', text: value.message }]
}
