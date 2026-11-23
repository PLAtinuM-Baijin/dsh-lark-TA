/**
 * 助教实例的受限命令工具 doc_exec。
 *
 * 只允许 unzip / pdftotext / pdfinfo / file 四个命令，execFile 直调（无 shell，
 * 通配符、管道、重定向都不存在）。作为输入的文件必须 realpath 落在课程目录或
 * 工作区，输出文件只能写工作区；子进程环境变量清空，不继承 TA_APP_SECRET 等密钥。
 * unzip 只放行 -p（导出到标准输出）、-l（列表）、-Z1（条目名）三种只读模式，
 * 绝不落地解压——否则可被用来解出指向工作区外的符号链接。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createPathScope } from './ta-fs-scope.js'

export const name = 'doc-exec'
export const inject = ['tools']

export const Config = Schema.object({
  readRoots: Schema.array(Schema.string()).default([]).description('只读根目录（课程目录等）'),
  writeRoot: Schema.string().default('').description('唯一可写的工作区根目录'),
  cwd: Schema.string().default('').description('相对路径的解析基准与命令工作目录；缺省用工作区'),
  timeoutMs: Schema.number().default(20000).description('单条命令的超时毫秒数'),
  maxOutputChars: Schema.number().default(20000).description('回显给模型的输出字符上限'),
})

const MAX_ARGS = 32
const MAX_ARG_CHARS = 500
const MAX_ENTRIES = 20
const MAX_BUFFER = 8 * 1024 * 1024
/** 子进程只拿最小环境：PATH 够找命令即可，绝不能带出密钥。 */
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
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
}

const PARAMETERS = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      enum: ['unzip', 'pdftotext', 'pdfinfo', 'file'],
      description: '要执行的命令；只有这四个。',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description:
        '按顺序给参数，原样传入、不要加引号。路径用绝对路径，或相对工作区 files/ 的路径。',
    },
  },
  required: ['command', 'args'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const scope = createPathScope(config)
  const workDir = config.cwd.trim() !== '' ? path.resolve(config.cwd.trim()) : scope.writeRoot
  const timeout = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 20000
  const maxOutputChars = Number.isFinite(config.maxOutputChars) && config.maxOutputChars > 0 ? config.maxOutputChars : 20000

  const tool = {
    name: 'doc_exec',
    description:
      '执行受限文档命令（无 shell）。command 只能是 unzip / pdftotext / pdfinfo / file。' +
      'unzip 只允许 -p（导出条目到标准输出）、-l（列表）、-Z1（条目名），不能落地解压；' +
      'pdftotext 用法「输入 输出」，输出用 - 表示打印；pdfinfo/file 查元信息和类型。' +
      '只能读课程目录与工作区，输出文件只能写工作区。' +
      '归档的 PPTX/DOCX/PDF 已自动抽好文字，优先直接读同名 .txt；要看逐页 XML、条目清单或其它文件时再用本工具。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('doc_exec: 参数必须是对象')
      }
      const command = args.command
      if (!['unzip', 'pdftotext', 'pdfinfo', 'file'].includes(command)) {
        throw new Error(`doc_exec: 不支持的命令 ${String(command)}；只有 unzip/pdftotext/pdfinfo/file`)
      }
      const rawArgs = args.args
      if (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGS) {
        throw new Error(`doc_exec: args 必须是字符串数组，最多 ${MAX_ARGS} 个`)
      }
      for (const arg of rawArgs) {
        if (typeof arg !== 'string' || arg === '' || arg.length > MAX_ARG_CHARS || arg.includes('\u0000')) {
          throw new Error('doc_exec: 每个参数必须是长度合规的非空字符串')
        }
      }
      await fs.mkdir(workDir, { recursive: true, mode: 0o700 }).catch(() => undefined)
      const argv = await buildArgv(command, rawArgs, scope, workDir)
      const result = await run(command, argv, workDir, timeout)
      const stdout = result.stdout.trimEnd()
      const shown = truncate(stdout, maxOutputChars)
      const stderr = truncate(result.stderr.trim(), 4000)
      const header = `$ ${command} ${argv.map(quoteForDisplay).join(' ')}`
      const parts = [header]
      if (shown !== '') parts.push(shown)
      if (result.exitCode !== 0) parts.push(`[exit ${result.exitCode}]${stderr === '' ? '' : `\n${stderr}`}`)
      else if (shown === '') parts.push('（没有输出）')
      return { ok: result.exitCode === 0, text: parts.join('\n') }
    },
  }
  ctx.tools.register(tool)
}

/** 按命令各自的语法校验参数，并把路径参数换成 realpath 后的绝对路径。 */
async function buildArgv(command, rawArgs, scope, workDir) {
  if (command === 'unzip') {
    const { flags, positional } = splitArgs(rawArgs)
    const mode = flags.length === 1 ? flags[0] : undefined
    if (!['-p', '-l', '-Z1'].includes(mode)) {
      throw new Error('doc_exec: unzip 必须且只能给一个模式：-p、-l 或 -Z1')
    }
    if (positional.length < 1) throw new Error('doc_exec: unzip 需要给出压缩包路径')
    const archive = await resolveInput(positional[0], scope, workDir)
    const entries = positional.slice(1)
    if (entries.length > MAX_ENTRIES) throw new Error(`doc_exec: 条目最多 ${MAX_ENTRIES} 个`)
    for (const entry of entries) {
      if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
        throw new Error(`doc_exec: 条目名不能是绝对路径或包含 ..：${entry}`)
      }
    }
    return [mode, archive, ...entries]
  }

  if (command === 'pdftotext') {
    const { flags, positional } = splitArgs(rawArgs)
    for (const flag of flags) {
      if (flag !== '-layout' && flag !== '-raw') throw new Error(`doc_exec: pdftotext 不支持的选项 ${flag}`)
    }
    if (positional.length !== 2) throw new Error('doc_exec: pdftotext 需要两个参数：输入 PDF 和输出（- 表示打印）')
    const input = await resolveInput(positional[0], scope, workDir)
    const output = positional[1] === '-' ? '-' : await resolveOutput(positional[1], scope, workDir)
    return [...flags, input, output]
  }

  if (command === 'pdfinfo') {
    const { flags, positional } = splitArgs(rawArgs)
    if (flags.length > 0) throw new Error('doc_exec: pdfinfo 不接受选项')
    if (positional.length !== 1) throw new Error('doc_exec: pdfinfo 需要一个 PDF 路径')
    return [await resolveInput(positional[0], scope, workDir)]
  }

  // file
  const { flags, positional } = splitArgs(rawArgs)
  for (const flag of flags) {
    if (flag !== '-b') throw new Error(`doc_exec: file 不支持的选项 ${flag}`)
  }
  if (positional.length < 1 || positional.length > 10) throw new Error('doc_exec: file 需要 1-10 个路径')
  const paths = []
  for (const raw of positional) paths.push(await resolveInput(raw, scope, workDir))
  return [...flags, ...paths]
}

function splitArgs(rawArgs) {
  const flags = []
  const positional = []
  for (const arg of rawArgs) {
    if (arg.startsWith('-') && arg !== '-') flags.push(arg)
    else positional.push(arg)
  }
  return { flags, positional }
}

async function resolveInput(raw, scope, workDir) {
  const abs = path.isAbsolute(raw) ? raw : path.resolve(workDir, raw)
  return scope.resolveRead(abs)
}

async function resolveOutput(raw, scope, workDir) {
  const abs = path.isAbsolute(raw) ? raw : path.resolve(workDir, raw)
  return scope.resolveWrite(abs)
}

function run(command, argv, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, argv, { cwd, env: SAFE_ENV, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 })
        return
      }
      const exitCode = typeof error.code === 'number' ? error.code : error.killed ? 124 : 1
      if (error.code === 'ENOENT') {
        reject(new Error(`doc_exec: 服务器上没有 ${command} 这个命令`))
        return
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new Error(`doc_exec: 输出超过 ${MAX_BUFFER} 字节上限，请缩小范围（指定条目或页面）`))
        return
      }
      if (error.killed) {
        reject(new Error(`doc_exec: 命令超过 ${timeout}ms 被终止`))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode })
    })
  })
}

function truncate(text, limit) {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return `${chars.slice(0, limit).join('')}\n…（输出共 ${chars.length} 字符，已截断到 ${limit}）`
}

function quoteForDisplay(arg) {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg
}

function renderText(_args, value) {
  return [{ type: 'text', text: value.text }]
}
