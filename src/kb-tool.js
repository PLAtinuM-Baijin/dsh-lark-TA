/**
 * 助教经验知识库工具 feishu_kb。
 *
 * 作用域守卫是硬约束：只有夜间整理会话（默认 feishu-root）可以调用；
 * 普通答疑会话（班级群、助教小群、学生私聊）没有这个工具，即使被注入
 * 提示词也无法写知识库。答疑时助教用 ta_fs 按需查阅工作区 kb/ 目录。
 *
 * 知识库只收两类群聊里助教/老师的表述（可复用经验与学科知识都收），
 * 机器人回答不算来源；不收学生私聊与未发布的题目答案，规则写在整理员提示词里。
 */
import Schema from '@deepseek-ai/schemastery'
import {
  READ_LIMIT,
  deleteTopic,
  isValidTopic,
  kbDir,
  listTopics,
  readTopic,
  setKbDir,
  writeTopic,
} from './kb-store.js'

export const name = 'feishu-kb-tool'
export const inject = ['tools']

export const Config = Schema.object({
  kbDir: Schema.string().description('知识库目录；缺省用 TA_KB_DIR 或 <TA_WORKSPACE>/kb'),
  curatorSessionId: Schema.string().default('feishu-root').description('允许维护知识库的整理会话 id'),
})

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'read', 'write', 'append', 'delete'],
      description: 'list=列出主题；read=读主题全文；write=覆盖写入；append=追加到末尾；delete=删除主题。',
    },
    topic: {
      type: 'string',
      description: '主题（即文件名，不含 .md）：中文/字母/数字/下划线/连字符，最长 40 字，如「环境配置」。',
    },
    text: {
      type: 'string',
      description: 'write/append 的 Markdown 正文；自由格式，没有固定字段模板。',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    topic: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    content: { type: 'string' },
    bytes: { type: 'integer' },
    truncated: { type: 'boolean' },
  },
  required: ['ok', 'message'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  setKbDir(config.kbDir)
  const curatorSessionId = config.curatorSessionId

  ctx.tools.register({
    name: 'feishu_kb',
    description:
      '维护助教经验知识库（工作区 kb/，按主题分文件、自由 Markdown）。只有夜间整理会话可以写入；普通答疑会话用 ta_fs 查阅该目录即可。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId !== curatorSessionId) {
        throw new Error('feishu_kb: 知识库只由夜间整理会话维护，当前会话没有写入权限')
      }
      return execute(args)
    },
  })
}

async function execute(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('feishu_kb: 参数必须是对象')
  const action = args.action
  if (action !== 'list' && action !== 'read' && action !== 'write' && action !== 'append' && action !== 'delete') {
    throw new Error('feishu_kb: action 必须是 list / read / write / append / delete')
  }

  if (action === 'list') {
    const topics = await listTopics()
    return {
      ok: true,
      message: topics.length === 0 ? `知识库还是空的（${kbDir()}）` : `共 ${topics.length} 个主题`,
      topics: topics.map((item) => {
        const preview = item.preview === '' ? '' : `：${clip(item.preview, 60)}`
        return `${item.topic}（${formatBytes(item.bytes)}${preview}）`
      }),
    }
  }

  const topic = typeof args.topic === 'string' ? args.topic.trim() : ''
  if (!isValidTopic(topic)) {
    throw new Error('feishu_kb: 需要合法的 topic（中文/字母/数字/下划线/连字符，最长 40 字）')
  }

  if (action === 'read') {
    const result = await readTopic(topic)
    if (!result.exists) return { ok: true, topic, message: `主题「${topic}」还不存在`, content: '' }
    const chars = Array.from(result.text)
    const truncated = chars.length > READ_LIMIT
    return {
      ok: true,
      topic,
      bytes: result.bytes,
      truncated,
      message: `${topic}.md（${formatBytes(result.bytes)}${truncated ? `，超过 ${READ_LIMIT} 字，已截断` : ''}）`,
      content: truncated ? chars.slice(0, READ_LIMIT).join('') : result.text,
    }
  }

  if (action === 'delete') {
    const result = await deleteTopic(topic)
    return { ok: true, topic, message: result.removed ? `已删除主题「${topic}」` : `主题「${topic}」不存在` }
  }

  if (typeof args.text !== 'string' || args.text.trim() === '') {
    throw new Error('feishu_kb: write/append 需要非空的 text')
  }
  const result = await writeTopic(topic, args.text, { append: action === 'append' })
  return {
    ok: true,
    topic,
    bytes: result.bytes,
    message: action === 'append' ? `已追加到「${topic}」` : `已写入「${topic}」`,
  }
}

function renderResult(_args, value) {
  const lines = [value.message]
  for (const item of value.topics ?? []) lines.push(`- ${item}`)
  if (typeof value.content === 'string' && value.content !== '') lines.push('', value.content)
  return [{ type: 'text', text: lines.join('\n') }]
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} 字节`
  return `${(bytes / 1024).toFixed(1)}KB`
}

function clip(text, limit) {
  const chars = Array.from(text)
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text
}
