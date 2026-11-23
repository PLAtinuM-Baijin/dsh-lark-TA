/**
 * 助教实例的受控文件工具。
 *
 * 注册 read/write/edit/glob/grep 五个工具，所有路径都过 ta-fs-scope 的
 * 根目录校验：readRoots 只读（课程目录），writeRoot 唯一可写（工作区）。
 * 助教 preset 不挂原生 dsh-tool-fs / dsh-tool-fs-search / dsh-tool-bash，
 * 模型就没有其他读写通道。
 */
import Schema from '@deepseek-ai/schemastery'
import { createPathScope } from './ta-fs-scope.js'

export const name = 'ta-fs'
export const inject = ['tools']

export const Config = Schema.object({
  readRoots: Schema.array(Schema.string()).default([]).description('只读根目录（课程目录等）'),
  writeRoot: Schema.string().default('').description('唯一可写的工作区根目录'),
  maxReadBytes: Schema.number().default(262144).description('单次读取的字节上限'),
  maxReadLines: Schema.number().default(2000).description('单次读取的行数上限'),
  maxWriteBytes: Schema.number().default(2097152).description('单次写入的字节上限'),
  maxResults: Schema.number().default(200).description('glob/grep 默认的最大结果数'),
})

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const scope = createPathScope(config)
  const tools = [
    {
      name: 'read',
      description:
        '读取文本文件（带行号）。file_path 必须是绝对路径，只能读课程目录和工作区内的文件；二进制文件请用课件抽取产物。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
          offset: { type: 'integer', minimum: 1, description: '起始行号（1 起），缺省 1' },
          limit: { type: 'integer', minimum: 1, description: '最多读取多少行，缺省 2000' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      async execute(args) {
        assertArgs(args, 'read')
        const filePath = requireString(args, 'file_path')
        const result = await scope.readText(filePath, { offset: intArg(args, 'offset', 1), limit: intArg(args, 'limit', config.maxReadLines) })
        return { ok: true, text: result.text }
      },
    },
    {
      name: 'write',
      description:
        '写入文本文件（覆盖已有内容，父目录不存在会自动创建）。file_path 必须是绝对路径，只能写工作区。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
          content: { type: 'string', description: '要写入的完整文本内容' },
        },
        required: ['file_path', 'content'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      async execute(args) {
        assertArgs(args, 'write')
        const filePath = requireString(args, 'file_path')
        const content = requireString(args, 'content', { allowEmpty: true })
        const result = await scope.writeText(filePath, content)
        return { ok: true, text: `已写入 ${result.path}（${result.bytes} 字节）` }
      },
    },
    {
      name: 'edit',
      description:
        '替换文本文件里的一段内容。file_path 必须是绝对路径且在工作区内；old_string 必须唯一，配合 replace_all 可全部替换。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
          old_string: { type: 'string', description: '要替换的原文（必须与文件内容完全一致）' },
          new_string: { type: 'string', description: '替换后的内容' },
          replace_all: { type: 'boolean', description: '是否替换所有出现，缺省 false' },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      async execute(args) {
        assertArgs(args, 'edit')
        const filePath = requireString(args, 'file_path')
        const oldString = requireString(args, 'old_string')
        const newString = requireString(args, 'new_string', { allowEmpty: true })
        const result = await scope.editText(filePath, oldString, newString, args.replace_all === true)
        return { ok: true, text: `已编辑 ${result.path}（替换 ${result.count} 处）` }
      },
    },
    {
      name: 'glob',
      description:
        '按文件名模式查找文件，返回绝对路径列表。pattern 支持 *、**、?；path 是搜索起点（绝对路径，缺省工作区）。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '相对搜索起点的模式，例如 **/*.md' },
          path: { type: 'string', description: '搜索起点的绝对路径，缺省为工作区' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      async execute(args) {
        assertArgs(args, 'glob')
        const pattern = requireString(args, 'pattern')
        const start = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined
        const files = await scope.glob(pattern, start)
        return { ok: true, text: files.length === 0 ? '未找到匹配的文件' : files.join('\n') }
      },
    },
    {
      name: 'grep',
      description:
        '在文本文件里按正则逐行搜索，返回「文件:行号:内容」。path 缺省为工作区，glob 可额外限定文件名（例如 *.md）。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript 正则表达式' },
          path: { type: 'string', description: '搜索起点（绝对路径），缺省为工作区' },
          glob: { type: 'string', description: '可选的文件名过滤，例如 *.md' },
          ignore_case: { type: 'boolean', description: '是否忽略大小写' },
          max_results: { type: 'integer', minimum: 1, description: '最多返回多少条，缺省 200' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      async execute(args) {
        assertArgs(args, 'grep')
        const pattern = requireString(args, 'pattern')
        const results = await scope.grep(pattern, {
          path: typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined,
          glob: typeof args.glob === 'string' ? args.glob : undefined,
          ignoreCase: args.ignore_case === true,
          maxResults: intArg(args, 'max_results', config.maxResults),
        })
        return { ok: true, text: results.length === 0 ? '没有匹配的内容' : results.join('\n') }
      },
    },
  ]
  for (const tool of tools) ctx.tools.register(tool)
}

function renderText(_args, value) {
  return [{ type: 'text', text: value.text }]
}

function assertArgs(args, tool) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`ta-fs(${tool}): 参数必须是对象`)
  }
}

function requireString(args, key, { allowEmpty = false } = {}) {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`ta-fs: ${key} 必须是字符串`)
  if (!allowEmpty && value.trim() === '') throw new Error(`ta-fs: ${key} 不能为空`)
  return value
}

function intArg(args, key, fallback) {
  const value = args[key]
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}
