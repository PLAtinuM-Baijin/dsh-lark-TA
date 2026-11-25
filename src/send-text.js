/**
 * 主动发消息工具 feishu_send_text（助教版）。
 *
 * 只挂在 feishu-ta preset，调用方必须是助教/老师小群（managerChatIds）的会话；
 * 学生私聊、班级群、记忆整理会话一律拒绝。
 * 目标是「立刻以新消息的形式主动说话」，不引用任何消息，也不经过本轮回复路径。
 */
import Schema from '@deepseek-ai/schemastery'
import { getChannelRuntime } from './channel-runtime.js'

export const name = 'feishu-send-text'
export const inject = ['tools']

export const Config = Schema.object({
  managerChatIds: Schema.array(Schema.string()).default([]).description('可以主动发送的助教/老师小群 chat_id'),
  allowedChatIds: Schema.array(Schema.string()).default([]).description('允许作为发送目标的群聊 chat_id（班级群、助教/老师小群）'),
})

const CHAT_SESSION = /^feishu-(oc_[A-Za-z0-9]+)-\d{8}$/
const MAX_TEXT_CHARS = 20000

const PARAMETERS = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: '要发送的 Markdown 内容；飞书按 CommonMark + GFM 渲染，过长会自动拆条。',
    },
    chat_id: {
      type: 'string',
      description: '可选的目标聊天：缺省是当前会话（助教/老师小群）；给班级群的 chat_id 可以主动发到群里。',
    },
  },
  required: ['text'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    chatId: { type: 'string' },
    messageIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'message'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const managerChatIds = new Set(
    (config.managerChatIds ?? (process.env.TA_MANAGER_CHAT_IDS ?? '').split(','))
      .map((id) => id.trim())
      .filter(Boolean),
  )
  const allowedChatIds = new Set(
    (config.allowedChatIds ?? (process.env.TA_GROUP_CHAT_IDS ?? '').split(','))
      .map((id) => id.trim())
      .filter(Boolean),
  )

  ctx.tools.register({
    name: 'feishu_send_text',
    description:
      '立刻主动给飞书聊天发一条新消息（不引用任何消息）。只有助教/老师小群可用；默认发到当前小群，也可以指定班级群。正常回复会自动发出，只有需要单独多说一句时才用它。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
    },
    async execute(args, exec) {
      return execute(args, exec, { managerChatIds, allowedChatIds })
    },
  })
}

async function execute(args, exec, options) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('feishu_send_text: 参数必须是对象')
  }
  const callerChatId = managerChatOf(exec, options)
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (text === '') throw new Error('feishu_send_text: 需要 text')
  if (Array.from(text).length > MAX_TEXT_CHARS) {
    throw new Error(`feishu_send_text: text 超过 ${MAX_TEXT_CHARS} 字符`)
  }

  const rawTarget = typeof args.chat_id === 'string' ? args.chat_id.trim() : ''
  const target = rawTarget === '' ? callerChatId : rawTarget
  if (target !== callerChatId && !options.allowedChatIds.has(target)) {
    throw new Error(`feishu_send_text: ${target} 不是已配置的群聊，拒绝发送`)
  }

  const runtime = getChannelRuntime()
  if (runtime === undefined) throw new Error('feishu_send_text: feishu-channel 插件未加载，无法发送')

  const messageIds = await runtime.sendChatText(target, text)
  return {
    ok: true,
    message: `已主动发送到 ${target}${messageIds.length > 1 ? `（拆成 ${messageIds.length} 条）` : ''}。`,
    chatId: target,
    messageIds,
  }
}

function managerChatOf(exec, options) {
  if (options.managerChatIds.size === 0) throw new Error('feishu_send_text: 没有配置助教/老师小群，拒绝发送')
  const sessionId = exec.agent?.session?.id
  const match = typeof sessionId === 'string' ? CHAT_SESSION.exec(sessionId) : null
  if (match === null) throw new Error('feishu_send_text: 当前会话不是飞书聊天会话，不能主动发送')
  if (!options.managerChatIds.has(match[1])) throw new Error('feishu_send_text: 只有助教/老师小群可以主动发送')
  return match[1]
}

function renderResult(_args, value) {
  return [{ type: 'text', text: value.message }]
}
