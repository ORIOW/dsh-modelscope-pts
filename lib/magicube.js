/**
 * dsh-modelscope-pts/magicube — 每日魔粒互动（子路径插件）。
 *
 * 独立组件入口：cordis.patch.yml 的第二条 insert（id: modelscope-magicube，
 * name: dsh-modelscope-pts/magicube）指向本模块。与余额组件（lib/index.js）
 * 同属一个 bundle，但各自独立启停、独立配置、独立 RPC 通道。
 *
 * 职责：每到用户设定的每日时间（错过则在启动后的首次检查补跑），用已配置的
 * 会话 Cookie 为 ModelScope 上「未星标、非本人创建、今日没点过」的模型点赞，
 * 领取魔粒（2 分/次，每日 10 次封顶）。点赞必须用完整 Cookie（含 httpOnly 的
 * m_session_id 与 csrf_token）——仅访问令牌不可点赞，令牌只服务余额组件。
 *
 * 上游接口（任务单 2026-11-22 真机实测，勿改勿再探测）：
 *   GET  /api/v1/users/info                  大写信封 {Code:200, Data:{user_name}}
 *   PUT  /api/v1/dolphin/models              翻页列模型（SortBy 仅 "Default" 有效）
 *   PUT  /api/v1/models/{Path}/{Name}/stars  点赞，{Code:200, Data:{Stars}, Success:true}
 *   与 /openapi/v1 的小写信封是两套，解析不得混用。
 *
 * 硬约束：
 *   - 两次点赞之间随机延时 1000 + random()*9000 毫秒（1~10 秒）；
 *   - 点赞是 toggle：只对 AlreadyStar=false 的模型发赞，并排除今日已点集合
 *     （否则第二次点同一个模型会取消喜欢）；
 *   - 凭据原文绝不进日志/RPC/UI；RPC 只返回布尔状态与结果摘要；
 *   - 普通字段（dailyTime/likeCount）编辑会重启插件；运行状态经 .volatile()
 *     字段原地持久化（schemastery .volatile() 已在 app.asar 源码实证存在，
 *     见 docs/dev-notes-20261122-004.md）。
 *
 * @module dsh-modelscope-pts/magicube
 */
import z from '@deepseek-ai/schemastery'
import { mountRpcChannel } from './rpc.js'

/** 子路径插件名，与 cordis.patch.yml 第二条 insert 的 name 一致。 */
export const name = 'dsh-modelscope-pts/magicube'

/** 本插件依赖的服务；密钥存取走 ctx.credentials（与余额组件同一凭据记录）。 */
export const inject = ['credentials']

/** 用户信息端点（取 user_name 用于排除本人模型）。 */
export const WHOAMI_URL = 'https://www.modelscope.cn/api/v1/users/info'
/** 模型列表端点（翻页 PUT）。 */
export const LIST_URL = 'https://www.modelscope.cn/api/v1/dolphin/models'
/** 点赞端点前缀；完整 URL = 本前缀 + /{encodeURIComponent(Path)}/{encodeURIComponent(Name)}/stars。 */
export const MODELS_BASE_URL = 'https://www.modelscope.cn/api/v1/models'

/** RPC 通道前缀，client 侧必须以同一个字符串调用。 */
export const CHANNEL = '/dsh-modelscope-pts-magicube'

/**
 * 凭据记录键：**复用余额组件的记录**（同包注册名作 owner 段），用户只需配一次
 * 凭据。两段都匹配 /^[a-z][a-z0-9-]*$/ 文法（与 dsh-credentials 一致）。
 */
const TOKEN_KEY = 'dsh-modelscope-pts/modelscope-token'
const COOKIE_KEY = 'dsh-modelscope-pts/modelscope-cookie'

/** 请求体上限。本通道载荷只有设置与状态摘要，64 KiB 与余额组件一致。 */
const MAX_BODY_BYTES = 65_536

/** 调度 tick 间隔：60 秒检查一次是否到达每日时间。 */
const TICK_MS = 60_000
/** 列模型翻页上限：≤6 页 × 100 条。 */
const MAX_LIST_PAGES = 6
const PAGE_SIZE = 100
/** 单次上游请求超时（毫秒）。接口实测毫秒级，15s 已非常宽。 */
const REQUEST_TIMEOUT_MS = 15_000
/** 两次点赞之间的随机延时：1000 + random()*9000 毫秒。 */
const DELAY_MIN_MS = 1_000
const DELAY_RANGE_MS = 9_000

/** 每日时间默认值与格式（HH:MM，24 小时制）。 */
export const DEFAULT_DAILY_TIME = '09:30'
export const DEFAULT_LIKE_COUNT = 10
/** HH:MM 的严格格式：00:00 ~ 23:59，两位数。 */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 部署侧配置。⚠️ 不含任何密钥字段 —— Cookie 走 ctx.credentials。
 *
 * lastRunDate / lastRunSummary 是运行状态，用 .volatile() 声明：
 * 编辑普通字段会让宿主重启插件，volatile 字段经 configEditor.edit 原地更新，
 * 读写不重启（host-plugin.md：「a field declared .volatile() updates in place
 * and is read with config.field.get()」）。读取端 config.lastRunDate 是
 * cosmokit 的 Volatile 引用（{get(): 快照}），快照只可能是字符串/undefined。
 */
export const Config = z.object({
  /** 每日运行时间（HH:MM）。格式在 apply 内正则校验（schema 层只保证是字符串）。 */
  dailyTime: z.string().default(DEFAULT_DAILY_TIME),
  /** 每次运行点赞数量。1~10：魔粒规则每日 10 次封顶。 */
  likeCount: z.number().min(1).max(10).default(DEFAULT_LIKE_COUNT),
  /** 最近一次任务运行日期（YYYY-MM-DD，本地时区）。volatile：任务结束原地写入。 */
  lastRunDate: z.string().default('').volatile(),
  /** 最近一次任务运行结果摘要（JSON 字符串，形状见 runDailyTask）。volatile：同上。 */
  lastRunSummary: z.string().default('').volatile(),
})

//#region 小工具（凭据读取 / 时间 / 随机延时）
/** 校验凭据键两段，防手拼笔误在存储层炸出难懂的错。 */
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/
function assertCredentialKey(key) {
  const halves = key.split('/')
  if (halves.length !== 2 || !halves.every((half) => KEY_SEGMENT.test(half))) {
    throw new TypeError(`credential key "${key}" must be <owner>/<id> with both halves matching ${String(KEY_SEGMENT)}`)
  }
  return key
}

/** 从一条凭据记录里安全取出 payload 的指定字段（trim 后返回；无值返回空串）。 */
function secretOf(record, field) {
  if (record === null || typeof record !== 'object') return ''
  const payload = record.payload
  if (payload === null || typeof payload !== 'object') return ''
  const value = payload[field]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读 volatile 字段的当前值。真实宿主下 config.lastRunDate 是 {get()} 引用；
 * 测试注入可能直接给普通字符串——两种形态都接住。
 */
function readVolatileString(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return typeof value === 'string' ? value : ''
  }
  return typeof field === 'string' ? field : ''
}

/** 本地时区 YYYY-MM-DD。调度门控与 lastRunDate 都用它，天然补跑按同一口径比较。 */
function dateStampOf(clock) {
  const year = clock.getFullYear()
  const month = String(clock.getMonth() + 1).padStart(2, '0')
  const day = String(clock.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 已校验的 HH:MM → 当日分钟数。 */
function minutesOfDay(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number)
  return hours * 60 + minutes
}

/** 每次请求生成唯一 trace id（与余额组件同一形状：时间戳+计数+随机段）。 */
let traceCounter = 0
function traceId() {
  traceCounter = (traceCounter + 1) % Number.MAX_SAFE_INTEGER
  return 'dsh-mgc-' + Date.now().toString(36) + '-' + traceCounter.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * 从 Cookie 串提取 csrf_token 并 decodeURIComponent（实测契约：X-CSRF-TOKEN 头
 * 取的是解码后的值）。Cookie 形如 "k=v; csrf_token=%7B...%7D; ..."。
 * 解码失败（畸形百分号转义）回退原值；找不到该键返回空串（调用方报错）。
 */
function extractCsrfToken(cookie) {
  const pair = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('csrf_token='))
  if (pair === undefined) return ''
  const raw = pair.slice('csrf_token='.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Fisher–Yates 洗牌（不改动入参），随机源可注入。 */
function shuffleWith(random, list) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const temp = out[i]
    out[i] = out[j]
    out[j] = temp
  }
  return out
}
//#endregion

//#region 大写信封解析与上游请求
/** /api/v1 大写信封：Code===200 视为成功（与 /openapi/v1 的小写信封严格区分）。 */
function parseEnvelope(json) {
  if (json === null || typeof json !== 'object') return { ok: false, message: '响应不是 JSON 对象' }
  if (json.Code !== 200) {
    const message = typeof json.Message === 'string' && json.Message !== '' ? json.Message : `Code=${String(json.Code)}`
    return { ok: false, message }
  }
  return { ok: true, data: json.Data }
}

/**
 * 发一次上游请求。永不 reject：网络错误/超时也返回 {status:0,...}，由策略层统一处理。
 * 超时经 AbortController 中断；每次调用独立 controller。
 */
async function requestJson(fetchImpl, url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    let json = null
    try {
      json = await response.json()
    } catch {
      json = null
    }
    return { status: response.status, json, cause: null }
  } catch (cause) {
    const message = controller.signal.aborted
      ? 'timeout'
      : cause instanceof Error
        ? cause.message
        : String(cause)
    return { status: 0, json: null, cause: message }
  } finally {
    clearTimeout(timer)
  }
}
//#endregion

/**
 * 装配每日魔粒互动组件。
 *
 * @param ctx - cordis 上下文。
 * @param config - 已解析的 Config（lastRunDate/lastRunSummary 是 Volatile 引用）。
 * @param deps - 测试注入点：`{fetchImpl, random, now, configEditor}` 全部可选，
 *   省略时用 globalThis.fetch / Math.random / 当前时间 / ctx.get('configEditor')。
 */
export function apply(ctx, config, deps) {
  const depSource = deps !== null && typeof deps === 'object' ? deps : {}
  const fetchImpl = typeof depSource.fetchImpl === 'function' ? depSource.fetchImpl : (...args) => globalThis.fetch(...args)
  const random = typeof depSource.random === 'function' ? depSource.random : Math.random
  const now = typeof depSource.now === 'function' ? depSource.now : () => new Date()
  const depsConfigEditor = depSource.configEditor
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const configRef = config !== null && typeof config === 'object' ? config : {}

  /**
   * 当前生效设置。dailyTime 在 apply 内正则校验（任务单要求校验点在这里）：
   * 非法值回退默认并告警——schema 层只保证是字符串，profile 可能被手改成任何文本。
   * likeCount 同理做 1~10 整数兜底。普通字段在插件重启前不会变，apply 装配时定死。
   */
  const rawDailyTime = typeof configRef.dailyTime === 'string' ? configRef.dailyTime : ''
  const rawLikeCount = Number(configRef.likeCount)
  const effectiveSettings = {
    dailyTime: TIME_PATTERN.test(rawDailyTime) ? rawDailyTime : DEFAULT_DAILY_TIME,
    likeCount: Number.isInteger(rawLikeCount) && rawLikeCount >= 1 && rawLikeCount <= 10 ? rawLikeCount : DEFAULT_LIKE_COUNT,
  }
  if (rawDailyTime !== effectiveSettings.dailyTime) {
    console.warn(`[modelscope-magicube] invalid dailyTime ${JSON.stringify(rawDailyTime)}, falling back to ${DEFAULT_DAILY_TIME}`)
  }
  if (rawLikeCount !== effectiveSettings.likeCount) {
    console.warn(`[modelscope-magicube] invalid likeCount ${String(configRef.likeCount)}, falling back to ${DEFAULT_LIKE_COUNT}`)
  }

  assertCredentialKey(TOKEN_KEY)
  assertCredentialKey(COOKIE_KEY)

  console.log(`[modelscope-magicube] loaded (dailyTime=${effectiveSettings.dailyTime}, likeCount=${effectiveSettings.likeCount})`)

  /** 运行互斥标记：调度 tick 与手动 runNow 共用，同一时刻最多一次任务。 */
  let running = false

  /** 读取一条凭据记录的指定字段。只返回值本身给本闭包，绝不进日志。 */
  async function readSecret(key, field) {
    try {
      const record = await ctx.credentials.readRecord(key)
      return secretOf(record, field)
    } catch (error) {
      // 只记错误形态，不记值 —— 密钥纪律。
      console.error(`[modelscope-magicube] read credential ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** 解析 volatile 字段里的运行摘要；损坏/非对象一律按 null 处理，绝不抛出。 */
  function parseSummary(raw) {
    if (typeof raw !== 'string' || raw === '') return null
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** 今日已点集合：仅当摘要的 date 就是今天时取其 liked 路径（跨日自动失效）。 */
  function readTodayLiked(today) {
    const parsed = parseSummary(readVolatileString(configRef.lastRunSummary))
    if (parsed === null || parsed.date !== today || !Array.isArray(parsed.liked)) return []
    return parsed.liked.filter(
      (item) => item !== null && typeof item === 'object' && typeof item.path === 'string' && item.path !== '',
    )
  }

  /**
   * 解析 configEditor 与 fiber.entry。deps.configEditor 是测试注入点（优先），
   * 生产走 ctx.get('configEditor')；两者都缺席时返回 undefined（调用方决定报错
   * 还是告警继续）。
   */
  function resolveEditor() {
    let editor
    try {
      if (depsConfigEditor !== undefined && depsConfigEditor !== null) {
        editor = depsConfigEditor
      } else if (typeof ctx.get === 'function') {
        editor = ctx.get('configEditor')
      }
    } catch (error) {
      console.warn(`[modelscope-magicube] reading configEditor failed: ${error instanceof Error ? error.message : String(error)}`)
      return { editor: undefined, entry: undefined }
    }
    const fiber = ctx.fiber !== null && typeof ctx.fiber === 'object' ? ctx.fiber : undefined
    return { editor, entry: fiber === undefined ? undefined : fiber.entry }
  }

  /**
   * 把运行摘要写入 volatile 字段（lastRunDate + lastRunSummary 原地更新，不重启）。
   * editor/entry 缺席时 console.warn 继续——任务已经跑完，持久化失败只损失记录，
   * 不能把已发生的点赞回滚掉。
   */
  async function persistSummary(today, summary) {
    const { editor, entry } = resolveEditor()
    if (editor === undefined || editor === null || entry === undefined || entry === null) {
      console.warn('[modelscope-magicube] configEditor/fiber.entry unavailable, run result cannot be persisted (this run itself is unaffected)')
      return false
    }
    try {
      await editor.edit(entry, (current) => {
        const base = current !== null && typeof current === 'object' ? current : {}
        return { ...base, lastRunDate: today, lastRunSummary: JSON.stringify(summary) }
      })
      console.log(`[modelscope-magicube] run result persisted (lastRunDate=${today})`)
      return true
    } catch (error) {
      console.warn(`[modelscope-magicube] persisting run result failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * 翻页收集候选模型。停止条件（先到先停）：
   *   - 候选数达到 need*3（洗牌前的「过量收集」，给随机挑选留余地）；
   *   - 某页返回不足 PAGE_SIZE 条（目录末页）；
   *   - 翻满 MAX_LIST_PAGES 页。
   * 候选过滤（任务单硬约束）：AlreadyStar 为假 && Path≠user_name &&
   * CreatedBy≠user_name && 不在今日已点集合。
   */
  async function collectCandidates({ cookie, userName, excludePaths, wanted }) {
    const candidates = []
    const target = wanted * 3
    let pages = 0
    for (let pageNumber = 1; pageNumber <= MAX_LIST_PAGES; pageNumber++) {
      pages = pageNumber
      const attempt = await requestJson(fetchImpl, LIST_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          PageSize: PAGE_SIZE,
          PageNumber: pageNumber,
          SortBy: 'Default',
          Target: '',
          SingleCriterion: [],
          Criterion: [],
        }),
      })
      // 列表阶段的 401/403 同样意味着 Cookie 失效，直接中断（不重试、不换页）。
      if (attempt.status === 401 || attempt.status === 403) {
        return { ok: false, reason: 'cookie', candidates, pages }
      }
      if (attempt.status !== 200) {
        const cause = attempt.status === 0 ? `网络错误：${attempt.cause ?? '未知原因'}` : `HTTP ${attempt.status}`
        return { ok: false, reason: cause, candidates, pages }
      }
      const parsed = parseEnvelope(attempt.json)
      if (!parsed.ok) {
        return { ok: false, reason: parsed.message, candidates, pages }
      }
      const models = parsed.data !== null && typeof parsed.data === 'object' ? parsed.data.Model : undefined
      const list = models !== null && typeof models === 'object' && Array.isArray(models.Models) ? models.Models : null
      if (list === null) {
        return { ok: false, reason: '响应缺少 Data.Model.Models', candidates, pages }
      }
      for (const model of list) {
        if (model === null || typeof model !== 'object') continue
        // ⚠️ 接口契约：model.Path 是命名空间（org 名，如 "MiniMax"），model.Name 才是模型名；
        // 完整模型路径 = `${Path}/${Name}`，与点赞 URL 的两段一一对应。
        const namespace = typeof model.Path === 'string' ? model.Path : ''
        const modelName = typeof model.Name === 'string' ? model.Name : ''
        if (namespace === '' || modelName === '') continue
        const fullPath = namespace + '/' + modelName
        // 点赞是 toggle：AlreadyStar=true 的再点一次会取消喜欢，必须跳过。
        if (model.AlreadyStar) continue
        // 不给自己创建/名下的模型点赞（Path 段即本人命名空间）。
        if (namespace === userName || model.CreatedBy === userName) continue
        // 今日（含手动 runNow）已经点过的模型再点会取消喜欢，必须排除（按完整路径）。
        if (excludePaths.has(fullPath)) continue
        candidates.push({ path: fullPath, name: modelName, namespace })
        if (candidates.length >= target) {
          return { ok: true, candidates, pages, exhausted: false }
        }
      }
      if (list.length < PAGE_SIZE) {
        return { ok: true, candidates, pages, exhausted: true }
      }
    }
    return { ok: true, candidates, pages, exhausted: true }
  }

  /**
   * 执行一次任务（调度或手动），返回结果摘要；内部所有失败路径都收敛成摘要
   * 字段，绝不抛出。摘要形状（JSON 持久化进 volatile lastRunSummary）：
   *   { date, ok, trigger, wanted, likedCount, failedCount, skippedCount,
   *     liked:[{path,name,stars}], failed:[{path,name,error}],
   *     interrupted:null|'cookie', error:null|string, startedAt, finishedAt }
   * liked 是「今日累计」（与当天此前运行合并去重，供跨运行的今日已点集合使用）；
   * likedCount/failedCount/skippedCount 是本次尝试的计数；ok = 本次按计划
   * 全部点赞成功（无顶层错误、无中断、likedCount === wanted）。
   */
  async function executeRun({ trigger, today, startedAt }) {
    const wanted = effectiveSettings.likeCount
    const finalize = ({ liked, failed, interrupted, error }) => {
      const likedCount = liked.length
      const failedCount = failed.length
      const skippedCount = Math.max(0, wanted - likedCount - failedCount)
      // 与当天此前运行的 liked 合并去重：runNow 二次运行后，今日已点集合必须
      // 覆盖两次点赞，否则第三次运行会重复点赞同一个模型（toggle 取消喜欢）。
      const prior = readTodayLiked(today)
      const seen = new Set()
      const mergedLiked = []
      for (const item of [...prior, ...liked]) {
        if (seen.has(item.path)) continue
        seen.add(item.path)
        mergedLiked.push(item)
      }
      const summary = {
        date: today,
        ok: error === null && interrupted === null && likedCount === wanted,
        trigger,
        wanted,
        likedCount,
        failedCount,
        skippedCount,
        liked: mergedLiked,
        failed,
        interrupted,
        error,
        startedAt,
        finishedAt: new Date(now()).toISOString(),
      }
      console.log(
        `[modelscope-magicube] run done: liked=${likedCount}/${wanted}, failed=${failedCount}, skipped=${skippedCount}` +
          (interrupted === null ? '' : `, interrupted=${interrupted}`) +
          (error === null ? '' : `, error=${error}`),
      )
      return summary
    }

    try {
      // —— 凭据门：点赞必须用完整 Cookie；令牌只服务余额组件，这里只读不作鉴权 ——
      const cookie = await readSecret(COOKIE_KEY, 'cookie')
      const token = await readSecret(TOKEN_KEY, 'token')
      if (token !== '') {
        console.log('[modelscope-magicube] access token present; likes still use the session cookie (token cannot like)')
      }
      if (cookie === '') {
        return finalize({
          liked: [],
          failed: [],
          interrupted: null,
          error: '未配置会话 Cookie：点赞必须使用完整 Cookie（仅访问令牌不可点赞），请在「ModelScope 魔粒余额」组件页填写',
        })
      }
      const csrfToken = extractCsrfToken(cookie)
      if (csrfToken === '') {
        return finalize({
          liked: [],
          failed: [],
          interrupted: null,
          error: 'Cookie 中缺少 csrf_token，无法点赞：请从已登录浏览器复制完整 Cookie（含 httpOnly 字段）',
        })
      }

      // —— WHOAMI：取 user_name，排除本人模型 ——
      const whoami = await requestJson(fetchImpl, WHOAMI_URL, {
        method: 'GET',
        headers: { cookie, 'x-modelscope-trace-id': traceId() },
      })
      if (whoami.status === 401 || whoami.status === 403) {
        return finalize({ liked: [], failed: [], interrupted: 'cookie', error: `Cookie 已失效（users/info 返回 HTTP ${whoami.status}）` })
      }
      if (whoami.status !== 200) {
        const cause = whoami.status === 0 ? `网络错误：${whoami.cause ?? '未知原因'}` : `HTTP ${whoami.status}`
        return finalize({ liked: [], failed: [], interrupted: null, error: `读取用户信息失败（${cause}）` })
      }
      const whoamiParsed = parseEnvelope(whoami.json)
      if (!whoamiParsed.ok) {
        return finalize({ liked: [], failed: [], interrupted: null, error: `读取用户信息失败：${whoamiParsed.message}` })
      }
      const userName =
        whoamiParsed.data !== null && typeof whoamiParsed.data === 'object' && typeof whoamiParsed.data.user_name === 'string'
          ? whoamiParsed.data.user_name
          : ''
      if (userName === '') {
        return finalize({ liked: [], failed: [], interrupted: null, error: '用户信息响应缺少 user_name' })
      }
      console.log(`[modelscope-magicube] whoami ok: user_name=${userName}`)

      // —— 候选收集：今日已点集合先排除 ——
      const excludePaths = new Set(readTodayLiked(today).map((item) => item.path))
      if (excludePaths.size > 0) {
        console.log(`[modelscope-magicube] excluding ${excludePaths.size} path(s) already liked today`)
      }
      const collected = await collectCandidates({ cookie, userName, excludePaths, wanted })
      if (!collected.ok) {
        if (collected.reason === 'cookie') {
          return finalize({ liked: [], failed: [], interrupted: 'cookie', error: 'Cookie 已失效（模型列表返回 HTTP 401/403）' })
        }
        return finalize({ liked: [], failed: [], interrupted: null, error: `收集候选模型失败：${collected.reason}` })
      }
      console.log(
        `[modelscope-magicube] candidates: ${collected.candidates.length} collected from ${collected.pages} page(s)` +
          (collected.exhausted ? ' (catalog exhausted)' : ''),
      )
      const targets = shuffleWith(random, collected.candidates).slice(0, wanted)
      if (targets.length === 0) {
        return finalize({ liked: [], failed: [], interrupted: null, error: '没有可点赞的候选模型（全部已星标或均为本人模型）' })
      }

      // —— 逐个点赞：相邻两次之间随机延时 1000+random()*9000 ms；401/403 中断 ——
      const liked = []
      const failed = []
      let interrupted = null
      for (const [index, target] of targets.entries()) {
        if (index > 0) {
          const delayMs = DELAY_MIN_MS + random() * DELAY_RANGE_MS
          console.log(`[modelscope-magicube] waiting ${Math.round(delayMs)}ms before like #${index + 1}/${targets.length}`)
          await sleep(delayMs)
        }
        // namespace/name 两段分别 encodeURIComponent（实测契约；path 字段是完整 "ns/name"，不能直接进 URL）。
        const url = `${MODELS_BASE_URL}/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/stars`
        const attempt = await requestJson(fetchImpl, url, {
          method: 'PUT',
          headers: {
            cookie,
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'x-modelscope-accept-language': 'zh_CN',
            'x-modelscope-trace-id': traceId(),
          },
          body: '{}',
        })
        if (attempt.status === 401 || attempt.status === 403) {
          interrupted = 'cookie'
          console.error(
            `[modelscope-magicube] like ${index + 1}/${targets.length} got HTTP ${attempt.status} — cookie expired, aborting remaining likes`,
          )
          break
        }
        const likeParsed = parseEnvelope(attempt.json)
        if (attempt.status === 200 && likeParsed.ok) {
          const stars = likeParsed.data !== null && typeof likeParsed.data === 'object' && typeof likeParsed.data.Stars === 'number' ? likeParsed.data.Stars : null
          liked.push({ path: target.path, name: target.name, namespace: target.namespace, stars })
          console.log(`[modelscope-magicube] like ${index + 1}/${targets.length} ok: ${target.path} (Stars=${String(stars)})`)
        } else {
          const detail =
            attempt.status === 0
              ? `网络错误：${attempt.cause ?? '未知原因'}`
              : likeParsed.ok
                ? `HTTP ${attempt.status}`
                : `HTTP ${attempt.status}：${likeParsed.message}`
          failed.push({ path: target.path, name: target.name, error: detail })
          console.error(`[modelscope-magicube] like ${index + 1}/${targets.length} failed: ${target.path} (${detail})`)
        }
      }
      return finalize({ liked, failed, interrupted, error: null })
    } catch (cause) {
      // 兜底：任何意外（含 persist 之外的 bug）都收敛成摘要，绝不让任务挂掉插件。
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`[modelscope-magicube] run crashed: ${message}`)
      return finalize({ liked: [], failed: [], interrupted: null, error: `任务异常中断：${message}` })
    }
  }

  /**
   * 一次任务attempt的完整闭环：互斥 → 执行 → 持久化。永不 reject。
   *
   * 失败也写 lastRunDate：缺凭据/Cookie 失效/网络故障若不落盘，60s 的 tick 会
   * 全天重试（对失效 Cookie 是持续打上游）；落盘后当天停止自动重试，用户修复
   * 凭据后用组件卡的「立即运行」恢复。摘要里保留失败原因供 UI 展示。
   */
  async function runDailyTask(trigger) {
    if (running) return
    running = true
    const startedClock = new Date(now())
    const startedAt = startedClock.toISOString()
    const today = dateStampOf(startedClock)
    try {
      console.log(`[modelscope-magicube] run start (trigger=${trigger}, date=${today}, dailyTime=${effectiveSettings.dailyTime}, likeCount=${effectiveSettings.likeCount})`)
      const summary = await executeRun({ trigger, today, startedAt })
      await persistSummary(today, summary)
    } catch (cause) {
      // executeRun 内部已兜底；这里只防 persistSummary 之外的意外。
      console.error(`[modelscope-magicube] run failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      running = false
    }
  }

  /** 调度检查：过了今日 dailyTime 且今天还没跑过 → 启动任务（天然补跑）。 */
  function tick() {
    const clock = new Date(now())
    const today = dateStampOf(clock)
    const lastRunDate = readVolatileString(configRef.lastRunDate)
    if (lastRunDate === today) return
    const currentMinutes = clock.getHours() * 60 + clock.getMinutes()
    if (currentMinutes < minutesOfDay(effectiveSettings.dailyTime)) return
    console.log(`[modelscope-magicube] tick: past ${effectiveSettings.dailyTime} on ${today} and not run yet — starting daily task`)
    void runDailyTask('schedule')
  }

  /** RPC 处理器：三端点，payload 只含设置与布尔状态，绝不回显凭据。 */
  const handler = async (endpoint, rawPayload) => {
    switch (endpoint) {
      case 'getStatus': {
        const cookie = await readSecret(COOKIE_KEY, 'cookie')
        const token = await readSecret(TOKEN_KEY, 'token')
        const lastRunDate = readVolatileString(configRef.lastRunDate)
        return {
          ok: true,
          value: {
            hasCookie: cookie !== '',
            hasToken: token !== '',
            dailyTime: effectiveSettings.dailyTime,
            likeCount: effectiveSettings.likeCount,
            todayDone: lastRunDate !== '' && lastRunDate === dateStampOf(new Date(now())),
            lastRunDate,
            lastRun: parseSummary(readVolatileString(configRef.lastRunSummary)),
            running,
          },
        }
      }
      case 'runNow': {
        // 手动触发：绕过 lastRunDate 门（当天已跑过也允许补点），但互斥不变，
        // 且候选收集仍排除今日已点集合（防 toggle 取消喜欢）。
        if (running) {
          return { ok: false, error: { code: 'internal', message: '已有一次互动任务在运行，请等它完成后再试', details: {} } }
        }
        console.log('[modelscope-magicube] manual run requested via RPC')
        void runDailyTask('manual')
        return { ok: true, value: { started: true, running: true } }
      }
      case 'saveSettings': {
        const payloadBody = rawPayload !== null && typeof rawPayload === 'object' ? rawPayload : {}
        const dailyTime = typeof payloadBody.dailyTime === 'string' ? payloadBody.dailyTime.trim() : ''
        const likeCount = Number(payloadBody.likeCount)
        const problems = []
        if (!TIME_PATTERN.test(dailyTime)) {
          problems.push('每日运行时间必须是 HH:MM（24 小时制两位数，如 09:30）')
        }
        if (!Number.isInteger(likeCount) || likeCount < 1 || likeCount > 10) {
          problems.push('每次点赞数量必须是 1~10 的整数')
        }
        if (problems.length > 0) {
          return { ok: false, error: { code: 'internal', message: problems.join('；'), details: {} } }
        }
        const { editor, entry } = resolveEditor()
        if (editor === undefined || editor === null || entry === undefined || entry === null) {
          return {
            ok: false,
            error: { code: 'internal', message: '配置编辑器在此环境不可用（configEditor 或 fiber.entry 缺席），无法保存设置', details: {} },
          }
        }
        try {
          await editor.edit(entry, (current) => {
            const base = current !== null && typeof current === 'object' ? current : {}
            return { ...base, dailyTime, likeCount }
          })
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: `保存设置被拒绝：${error instanceof Error ? error.message : String(error)}`,
              details: {},
            },
          }
        }
        console.log(`[modelscope-magicube] settings saved (dailyTime=${dailyTime}, likeCount=${likeCount}); ordinary fields apply after the plugin restarts`)
        return { ok: true, value: { dailyTime, likeCount } }
      }
      default:
        return { ok: false, error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} } }
    }
  }

  mountRpcChannel(ctx, CHANNEL, handler, MAX_BODY_BYTES)

  // 调度进 effect：disposer 真停表，不泄漏 interval。先立即 tick 一次——
  // 插件在每日时间之后启动（宿主刚开机/组件刚启用）时当场补跑。
  ctx.effect(() => {
    console.log(`[modelscope-magicube] scheduler started (intervalMs=${TICK_MS}, dailyTime=${effectiveSettings.dailyTime}, likeCount=${effectiveSettings.likeCount})`)
    tick()
    const timer = setInterval(() => tick(), TICK_MS)
    if (typeof timer?.unref === 'function') timer.unref()
    return () => {
      clearInterval(timer)
      console.log('[modelscope-magicube] scheduler stopped')
    }
  }, 'dsh-modelscope-pts/magicube: daily scheduler')
}
