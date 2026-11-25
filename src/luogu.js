/**
 * 洛谷题库工具 luogu（助教实例的上网通道，只访问 https://www.luogu.com.cn）。
 *
 * search：按关键字 / 难度 / 标签检索题目列表；
 * problem：取题目详情（题面、样例、限时、通过数）。
 * 通用 web fetch 仍然关闭：学生能用 prompt injection 借它访问内网，
 * 而选题只需要洛谷这一个来源，所以把出口收紧到固定域名。
 */
import Schema from '@deepseek-ai/schemastery'

export const name = 'luogu'
export const inject = ['tools']

export const Config = Schema.object({
  timeoutMs: Schema.number().default(15000).description('单次请求超时毫秒数'),
  maxStatementChars: Schema.number().default(6000).description('题面文字上限'),
  maxSamplesChars: Schema.number().default(4000).description('样例文字上限'),
  minIntervalMs: Schema.number().default(800).description('两次请求之间的最小间隔，避免滑条'),
})

const BASE = 'https://www.luogu.com.cn'
/** 不用浏览器 UA：洛谷对常见浏览器 UA 会 302 到风控页，纯脚本 UA 反而直接给页面。 */
const USER_AGENT = 'ta-course-bot/1.0'
const TAG_CACHE_MS = 6 * 60 * 60 * 1000
const MAX_PAGE_CHARS = 5 * 1024 * 1024
const DIFFICULTY_LABELS = ['未评定', '入门', '普及−', '普及/提高−', '普及+/提高', '提高+/省选−', '省选/NOI−', 'NOI/NOI+', '其他']

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
    action: {
      type: 'string',
      enum: ['search', 'problem'],
      description: 'search 检索题目列表；problem 取单题题面。',
    },
    keyword: { type: 'string', description: 'search：标题关键字，可省略。' },
    difficulty: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 8 },
      description: 'search：难度代号可多选。1 入门、2 普及−、3 普及/提高−、4 普及+/提高、5 提高+/省选−、6 省选/NOI−、7 NOI/NOI+。',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'search：知识点标签名，如「贪心」「动态规划」「二分」。',
    },
    page: { type: 'integer', minimum: 1, description: 'search：页码，缺省 1。' },
    limit: { type: 'integer', minimum: 1, maximum: 30, description: 'search：最多返回多少条，缺省 10。' },
    pid: { type: 'string', description: 'problem：题号，如 P1001、B2005、CF1A。' },
  },
  required: ['action'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const timeout = positiveInt(config.timeoutMs, 15000)
  const maxStatementChars = positiveInt(config.maxStatementChars, 6000)
  const maxSamplesChars = positiveInt(config.maxSamplesChars, 4000)
  const minInterval = positiveInt(config.minIntervalMs, 800)
  let lastRequestAt = 0
  let tagCache = { at: 0, byId: new Map(), byName: new Map() }

  async function request(pathText) {
    const wait = lastRequestAt + minInterval - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
    let res
    try {
      res = await fetch(`${BASE}${pathText}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' },
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      throw new Error(`访问洛谷失败：${error?.name === 'TimeoutError' ? '超时' : String(error?.message ?? error)}`)
    }
    if (!res.ok) throw new Error(`洛谷返回 HTTP ${res.status}`)
    const body = await res.text()
    if (body.length > MAX_PAGE_CHARS) throw new Error('洛谷响应过大，已放弃')
    return body
  }

  async function ensureTags() {
    if (Date.now() - tagCache.at < TAG_CACHE_MS) return tagCache
    const body = await request('/_lfe/tags')
    let data
    try {
      data = JSON.parse(body)
    } catch {
      throw new Error('洛谷标签数据解析失败')
    }
    const byId = new Map()
    const byName = new Map()
    for (const tag of Array.isArray(data?.tags) ? data.tags : []) {
      if (typeof tag?.id !== 'number' || typeof tag?.name !== 'string') continue
      byId.set(tag.id, tag.name)
      if (!byName.has(tag.name)) byName.set(tag.name, tag.id)
    }
    if (byId.size === 0) throw new Error('洛谷标签数据为空')
    tagCache = { at: Date.now(), byId, byName }
    return tagCache
  }

  async function resolveTagIds(names) {
    if (!Array.isArray(names) || names.length === 0) return []
    const { byName } = await ensureTags()
    const ids = []
    const missing = []
    for (const raw of names) {
      const name = String(raw).trim()
      if (name === '') continue
      if (byName.has(name)) {
        ids.push(byName.get(name))
        continue
      }
      const fuzzy = [...byName.entries()].filter(([key]) => key.includes(name) || name.includes(key))
      if (fuzzy.length === 0) missing.push(name)
      else ids.push(fuzzy[0][1])
    }
    if (missing.length > 0) throw new Error(`洛谷没有这些标签：${missing.join('、')}；换一个说法再试`)
    return [...new Set(ids)]
  }

  function parseContext(html) {
    const match = /<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
    if (match === null) throw new Error('没解析到洛谷页面数据（可能触发了风控或页面改版）')
    try {
      return JSON.parse(match[1])
    } catch {
      throw new Error('洛谷页面数据解析失败')
    }
  }

  function difficultyLabel(value) {
    if (!Number.isInteger(value)) return '未评定'
    return DIFFICULTY_LABELS[value] ?? `难度 ${value}`
  }

  function tagNames(ids, byId) {
    const names = (Array.isArray(ids) ? ids : []).map((id) => byId.get(id)).filter((name) => typeof name === 'string')
    if (names.length <= 6) return names.join('、')
    return `${names.slice(0, 6).join('、')} 等 ${names.length} 个`
  }

  async function search(args) {
    const params = new URLSearchParams({ type: 'P' })
    if (typeof args.keyword === 'string' && args.keyword.trim() !== '') params.set('keyword', args.keyword.trim())
    for (const value of Array.isArray(args.difficulty) ? args.difficulty : []) {
      const level = Number(value)
      if (!Number.isInteger(level) || level < 0 || level > 8) throw new Error(`难度代号不合法：${String(value)}`)
      params.append('difficulty', String(level))
    }
    for (const id of await resolveTagIds(args.tags)) params.append('tag', String(id))
    const page = Number.isInteger(args.page) && args.page > 0 ? args.page : 1
    params.set('page', String(page))

    const data = parseContext(await request(`/problem/list?${params.toString()}`)).data
    const problems = data?.problems
    if (!problems || !Array.isArray(problems.result)) throw new Error('洛谷列表数据缺失')
    const { byId } = await ensureTags()
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 30) : 10
    const rows = problems.result.slice(0, limit).map((item) => {
      const tags = tagNames(item.tags, byId)
      return `${item.pid}｜${item.name}｜难度：${difficultyLabel(item.difficulty)}${tags === '' ? '' : `｜标签：${tags}`}`
    })
    const perPage = Number.isInteger(problems.perPage) && problems.perPage > 0 ? problems.perPage : 50
    const total = Number.isInteger(problems.count) ? problems.count : rows.length
    const pages = Math.max(1, Math.ceil(total / perPage))
    const head = `洛谷「${[args.keyword, ...(args.tags ?? []), ...(args.difficulty ?? []).map((d) => difficultyLabel(Number(d)))].filter((part) => part !== undefined && part !== '').join(' ')}」：共 ${total} 题，第 ${page}/${pages} 页，显示 ${rows.length} 条`
    const more = page < pages ? `\n（还有更多，翻页用 page=${page + 1}）` : ''
    return { ok: true, text: `${head}\n${rows.join('\n')}${more}` }
  }

  async function problem(args) {
    const pid = typeof args.pid === 'string' ? args.pid.trim() : ''
    if (!/^[A-Za-z0-9_]{1,32}$/.test(pid)) throw new Error('题号格式不对，例如 P1001、B2005、CF1A')
    const data = parseContext(await request(`/problem/${pid}`)).data
    const p = data?.problem
    if (!p) throw new Error(`洛谷没有找到题目 ${pid}`)
    const { byId } = await ensureTags()
    const content = pickContent(p)
    const parts = [`${p.pid} ${p.name}`, `难度：${difficultyLabel(p.difficulty)}｜标签：${tagNames(p.tags, byId) || '无'}`]
    const time = Array.isArray(p.limits?.time) ? p.limits.time[0] : undefined
    const memory = Array.isArray(p.limits?.memory) ? p.limits.memory[0] : undefined
    const stats = []
    if (Number.isInteger(time)) stats.push(`限时 ${time}ms`)
    if (Number.isInteger(memory)) stats.push(`内存 ${Math.round(memory / 1024)}MB`)
    if (Number.isFinite(p.totalSubmit) && p.totalSubmit > 0) stats.push(`通过 ${p.totalAccepted}/${p.totalSubmit}`)
    if (stats.length > 0) parts.push(stats.join('｜'))
    parts.push(`链接：${BASE}/problem/${p.pid}`)

    const sections = [
      ['背景', content.background],
      ['题目描述', content.description],
      ['输入格式', content.formatI],
      ['输出格式', content.formatO],
      ['提示', content.hint],
    ]
    let budget = maxStatementChars
    for (const [title, value] of sections) {
      if (typeof value !== 'string' || value.trim() === '' || budget <= 0) continue
      const body = value.trim().slice(0, budget)
      budget -= body.length
      parts.push(`## ${title}\n${body}${body.length < value.trim().length ? '…（已截断）' : ''}`)
    }

    const samples = Array.isArray(p.samples) ? p.samples.slice(0, 3) : []
    let sampleBudget = maxSamplesChars
    for (const [index, sample] of samples.entries()) {
      if (!Array.isArray(sample) || sampleBudget <= 0) continue
      const input = String(sample[0] ?? '').slice(0, sampleBudget)
      const output = String(sample[1] ?? '').slice(0, Math.max(0, sampleBudget - input.length))
      sampleBudget -= input.length + output.length
      parts.push(`### 样例 ${index + 1}\n输入：\n\`\`\`\n${input.trimEnd()}\n\`\`\`\n输出：\n\`\`\`\n${output.trimEnd()}\n\`\`\``)
    }
    return { ok: true, text: parts.join('\n') }
  }

  function pickContent(p) {
    const translated = p?.translatedContent
    if (translated !== null && typeof translated === 'object' && typeof translated.description === 'string' && translated.description.trim() !== '') {
      return translated
    }
    return p?.content ?? {}
  }

  const tool = {
    name: 'luogu',
    description:
      '查洛谷题库（只访问 luogu.com.cn）。search 按标题关键字、难度、知识点标签检索；' +
      'problem 按题号取完整题面与样例。出题、找例题时优先用它检索真实题目，不要凭印象编题号。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('luogu: 参数必须是对象')
      if (args.action === 'search') return await search(args)
      if (args.action === 'problem') return await problem(args)
      throw new Error(`luogu: 不支持的 action ${String(args.action)}`)
    },
  }
  ctx.tools.register(tool)
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function renderText(_args, value) {
  return [{ type: 'text', text: value.text }]
}
