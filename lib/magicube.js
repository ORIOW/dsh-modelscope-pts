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
 * 0.3.0 新增两件事，与点赞共用同一条 60s 调度 tick：
 *   - 每日互动运行时自动用默认浏览器打开 ModelScope 页面领登录奖励（每天最多
 *     一次，volatile lastBrowserOpenDate 门控；URL 默认「我的概览」页
 *     https://www.modelscope.cn/my/overview，配置了自定义 openUrl 则优先；
 *     打开失败只记日志，绝不阻塞点赞）；
 *   - 周期探测 profile 补丁层 llm-pi-ai 行已添加模型的可用性（可用/推理不可用/
 *     已下架），经 RPC probeNow 端点与 getStatus.probe 字段供组件卡展示；探测
 *     与点赞互不阻塞，探测错误只影响探测状态。
 *
 * 上游接口（任务单 2026-11-22 真机实测，勿改勿再探测）：
 *   GET  /api/v1/users/info                  大写信封 {Code:200, Data:{user_name}}
 *   PUT  /api/v1/dolphin/models              翻页列模型（SortBy 仅 "Default" 有效）
 *   PUT  /api/v1/models/{Path}/{Name}/stars  点赞，{Code:200, Data:{Stars}, Success:true}
 *   与 /openapi/v1 的小写信封是两套，解析不得混用。
 *
 * 探测相关端点（任务单 2026-11-26 核实的契约）：
 *   GET  https://api-inference.modelscope.cn/v1/models   可推理模型清单（OpenAI
 *       形状 {object:"list", data:[{id,…}]}，匿名可读；凭据库解析到
 *       MODELSCOPE_API_KEY 时附 Bearer——值绝不进日志/RPC/UI）；
 *   GET  /api/v1/models/{ns}/{name}                      存在性判定：404 +
 *       Code 10010205001 = 已下架；200 = 存在（不在推理清单 → 「推理不可用」，
 *       可能为 gated 模型）。详情 Data.Tasks[0].ChineseName（缺则 Name）作分组。
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
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import yaml from 'js-yaml'
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
/** 可推理模型清单端点（OpenAI 形状；匿名可读，配了 MODELSCOPE_API_KEY 则带 Bearer）。 */
export const INFERENCE_MODELS_URL = 'https://api-inference.modelscope.cn/v1/models'
/** 登录奖励页默认地址：用户的「我的概览」页（真机可达；2026-11-26 起 /profile/{name} 页无法访问，弃用）。 */
export const MY_OVERVIEW_URL = 'https://www.modelscope.cn/my/overview'
/** profile 用户补丁层承载「用户已添加模型」的行 id（DSH configEditor 机写）。 */
export const PROFILE_ENTRY_ID = 'llm-pi-ai'
/** 存在性判定：404 + Code 10010205001 = 模型已下架（2026-11-26 核实契约）。 */
export const MODEL_REMOVED_CODE = 10010205001

/** 余额端点（宿主 lib/index.js 同款）：Cookie 中断后用它验证访问令牌是否仍有效。 */
export const BALANCE_URL = 'https://www.modelscope.cn/openapi/v1/magicubes/balance'
/** 访问令牌的凭据引用（llm-pi-ai provider 的 apiKeyEnv；大写下划线标识符文法）。 */
export const MODELSCOPE_API_KEY_REF = 'MODELSCOPE_API_KEY'

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
/** 探测间隔默认值（天）。 */
export const DEFAULT_PROBE_INTERVAL_DAYS = 14
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
  /** 每日互动运行时自动打开浏览器领登录奖励（每天最多一次，见 lastBrowserOpenDate）。 */
  openBrowser: z.boolean().default(true),
  /** 自定义打开地址（http/https）；空串 = 打开默认「我的概览」页。 */
  openUrl: z.string().default(''),
  /** 模型可用性探测间隔（天），下限 1；探测调度与点赞共用 60s tick。普通字段：编辑重启生效。 */
  probeIntervalDays: z.number().min(1).default(DEFAULT_PROBE_INTERVAL_DAYS),
  /** 任务/探测结束后弹浮动小窗通知。普通字段：编辑重启生效。 */
  popupNotify: z.boolean().default(true),
  /** 最近一次任务运行日期（YYYY-MM-DD，本地时区）。volatile：任务结束原地写入。 */
  lastRunDate: z.string().default('').volatile(),
  /** 最近一次任务运行结果摘要（JSON 字符串，形状见 runDailyTask）。volatile：同上。 */
  lastRunSummary: z.string().default('').volatile(),
  /** 最近一次打开奖励页的日期（YYYY-MM-DD，本地时区）。volatile：打开尝试后原地写入。 */
  lastBrowserOpenDate: z.string().default('').volatile(),
  /** 最近一次探测日期（YYYY-MM-DD，本地时区）。volatile：探测结束后原地写入。 */
  lastProbeDate: z.string().default('').volatile(),
  /** 最近一次探测结果摘要（JSON 字符串，形状见 executeProbe）。volatile：同上。 */
  lastProbeSummary: z.string().default('').volatile(),
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

//#region 奖励页打开与探测：模块级纯助手（不依赖 apply 作用域）
/**
 * 生产默认的浏览器打开实现：按平台挑命令，detached + stdio ignore，绝不抛出。
 * win32 用 rundll32 直调 ShellOpen（不过 cmd：URL 里的 & 等字符不会被当命令分隔符，
 * 也不需要 start 的空标题占位）。
 */
function defaultOpenUrlImpl(url) {
  try {
    let command
    let args
    if (process.platform === 'win32') {
      command = 'rundll32'
      args = ['url.dll,FileProtocolHandler', url]
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = [url]
    } else {
      command = 'xdg-open'
      args = [url]
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    // spawn 的 ENOENT 等错误走异步 'error' 事件；不挂监听会变成 unhandled 'error' 炸进程。
    child.on('error', (error) => {
      console.error(`[modelscope-magicube] browser spawn error: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (typeof child.unref === 'function') child.unref()
    return true
  } catch (error) {
    console.error(`[modelscope-magicube] opening browser failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** profile 补丁文件候选路径：DSH_PROFILE_DIR 优先（文件或目录皆可），兜底 %APPDATA% 同构路径。 */
function profilePatchCandidates() {
  const candidates = []
  const envValue = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (envValue !== '') {
    candidates.push(envValue)
    candidates.push(join(envValue, 'cordis.patch.yml'))
  }
  const appData = typeof process.env.APPDATA === 'string' ? process.env.APPDATA.trim() : ''
  if (appData !== '') {
    candidates.push(join(appData, 'dsh-desktop', 'harness', 'profiles', 'desktop', 'cordis.patch.yml'))
  }
  return candidates
}

/**
 * 容错 schema：真实 profile 用户补丁层允许 `!!js` 表达式（宿主加载器会求值），而
 * js-yaml 4 的 DEFAULT_SCHEMA 遇到未知 tag 直接抛错 —— 默认加载会在真实 profile
 * 上失败（本机实证）。这里把 !!js 系 tag 全部按「原样字符串」接住：本插件只读
 * llm-pi-ai 行的模型清单，从不解释 js 表达式，也不复用 DEFAULT_SCHEMA 单例
 * （避免变异影响同进程的其他 js-yaml 使用方）。
 */
let tolerantYamlSchemaCache = null
function tolerantYamlSchema() {
  if (tolerantYamlSchemaCache !== null) return tolerantYamlSchemaCache
  const rawString = (data) => data
  const jsTags = ['', '/function', '/regexp', '/undefined', '/eval'].map((suffix) =>
    new yaml.Type('tag:yaml.org,2002:js' + suffix, { kind: 'scalar', resolve: () => true, construct: rawString }),
  )
  tolerantYamlSchemaCache = new yaml.Schema({
    implicit: yaml.DEFAULT_SCHEMA.implicit,
    explicit: [...(yaml.DEFAULT_SCHEMA.explicit ?? []), ...jsTags],
  })
  return tolerantYamlSchemaCache
}

/**
 * 读 profile 用户补丁层的 llm-pi-ai 行，取 config.providers.modelscope.models[].id。
 * 返回 null = 读不到（文件缺失/解析失败/无该行）；[] = 有该行但没有 modelscope 模型。
 * 任何失败都收敛为 null，绝不抛出。
 */
/**
 * 从 profile 补丁 YAML 文本提取 llm-pi-ai 行的 modelscope 已配置模型 id。
 * 返回 null = 解析失败或无该行；[] = 有该行但没有 modelscope 模型。任何失败都收敛为 null，绝不抛出。
 * （独立导出：冒烟在有真实 js-yaml 的环境下用它做回归校验。）
 */
export function extractConfiguredModelIds(patchYamlText) {
  let doc
  try {
    doc = yaml.load(patchYamlText, { schema: tolerantYamlSchema() })
  } catch (error) {
    console.error(`[modelscope-magicube] profile patch parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (!Array.isArray(doc)) return null
  for (const entry of doc) {
    if (entry === null || typeof entry !== 'object' || entry.id !== PROFILE_ENTRY_ID) continue
    const config = entry.config !== null && typeof entry.config === 'object' ? entry.config : {}
    const providers = config.providers !== null && typeof config.providers === 'object' ? config.providers : {}
    const modelscope = providers.modelscope !== null && typeof providers.modelscope === 'object' ? providers.modelscope : {}
    const models = Array.isArray(modelscope.models) ? modelscope.models : []
    const ids = []
    for (const model of models) {
      if (model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id.trim() !== '') {
        ids.push(model.id.trim())
      }
    }
    return ids
  }
  return []
}

function readConfiguredModelIds() {
  for (const candidate of profilePatchCandidates()) {
    try {
      const ids = extractConfiguredModelIds(readFileSync(candidate, 'utf8'))
      if (ids !== null) return ids
      // null = 解析失败/无该行：换下一个候选；全部失败返回 null。
    } catch {
      // 该候选不可读（缺失/目录）：换下一个。
    }
  }
  return null
}

/** OpenAI 形状清单 → 可推理 id 集合；畸形返回 null（调用方按清单失败处理）。 */
function inferenceIdsOf(json) {
  if (json === null || typeof json !== 'object' || !Array.isArray(json.data)) return null
  const ids = new Set()
  for (const item of json.data) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '') ids.add(item.id)
  }
  return ids
}

/** 'ns/name' → 两段；无 '/' 或某段为空返回 null（调用方按「无法确认详情」处理）。 */
function splitModelId(id) {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  return { namespace: id.slice(0, slash), name: id.slice(slash + 1) }
}

/** 详情响应 → 分类名：Data.Tasks[0].ChineseName，缺则 Tasks[0].Name，再缺 null。 */
function detailCategoryOf(json) {
  if (json === null || typeof json !== 'object') return null
  const data = json.Data
  if (data === null || typeof data !== 'object') return null
  const tasks = Array.isArray(data.Tasks) ? data.Tasks : []
  const first = tasks.length > 0 ? tasks[0] : null
  if (first === null || typeof first !== 'object') return null
  if (typeof first.ChineseName === 'string' && first.ChineseName.trim() !== '') return first.ChineseName.trim()
  if (typeof first.Name === 'string' && first.Name.trim() !== '') return first.Name.trim()
  return null
}

/** 'YYYY-MM-DD' → 本地零点毫秒；非法返回 null（探测间隔比较用）。 */
function dateStampToMs(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp)
  if (match === null) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
}
//#endregion

/**
 * 装配每日魔粒互动组件。
 *
 * @param ctx - cordis 上下文。
 * @param config - 已解析的 Config（lastRunDate/lastRunSummary 等 volatile 字段是 Volatile 引用）。
 * @param deps - 测试注入点：`{fetchImpl, random, now, configEditor, openUrlImpl}` 全部可选，
 *   省略时用 globalThis.fetch / Math.random / 当前时间 / ctx.get('configEditor') /
 *   defaultOpenUrlImpl（真实 spawn 浏览器）。
 */
export function apply(ctx, config, deps) {
  const depSource = deps !== null && typeof deps === 'object' ? deps : {}
  const fetchImpl = typeof depSource.fetchImpl === 'function' ? depSource.fetchImpl : (...args) => globalThis.fetch(...args)
  const random = typeof depSource.random === 'function' ? depSource.random : Math.random
  const now = typeof depSource.now === 'function' ? depSource.now : () => new Date()
  const depsConfigEditor = depSource.configEditor
  const openUrlImpl = typeof depSource.openUrlImpl === 'function' ? depSource.openUrlImpl : defaultOpenUrlImpl
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const configRef = config !== null && typeof config === 'object' ? config : {}

  /**
   * 当前生效设置。dailyTime 在 apply 内正则校验（任务单要求校验点在这里）：
   * 非法值回退默认并告警——schema 层只保证是字符串，profile 可能被手改成任何文本。
   * likeCount 同理做 1~10 整数兜底。普通字段在插件重启前不会变，apply 装配时定死。
   */
  const rawDailyTime = typeof configRef.dailyTime === 'string' ? configRef.dailyTime : ''
  const rawLikeCount = Number(configRef.likeCount)
  const rawProbeIntervalDays = Number(configRef.probeIntervalDays)
  const effectiveSettings = {
    dailyTime: TIME_PATTERN.test(rawDailyTime) ? rawDailyTime : DEFAULT_DAILY_TIME,
    likeCount: Number.isInteger(rawLikeCount) && rawLikeCount >= 1 && rawLikeCount <= 10 ? rawLikeCount : DEFAULT_LIKE_COUNT,
    openBrowser: configRef.openBrowser !== false,
    // 自定义地址必须是 http(s)：saveSettings UI 路径已校验；手改 profile 的旧值在此兑底，
    // 防止任意字符串被送进 rundll32/spawn 参数。
    openUrl: typeof configRef.openUrl === 'string' && /^https?:\/\//i.test(configRef.openUrl.trim()) ? configRef.openUrl.trim() : '',
    popupNotify: configRef.popupNotify !== false,
    probeIntervalDays:
      Number.isInteger(rawProbeIntervalDays) && rawProbeIntervalDays >= 1 ? rawProbeIntervalDays : DEFAULT_PROBE_INTERVAL_DAYS,
  }
  if (rawDailyTime !== effectiveSettings.dailyTime) {
    console.warn(`[modelscope-magicube] invalid dailyTime ${JSON.stringify(rawDailyTime)}, falling back to ${DEFAULT_DAILY_TIME}`)
  }
  if (rawLikeCount !== effectiveSettings.likeCount) {
    console.warn(`[modelscope-magicube] invalid likeCount ${String(configRef.likeCount)}, falling back to ${DEFAULT_LIKE_COUNT}`)
  }
  if (rawProbeIntervalDays !== effectiveSettings.probeIntervalDays) {
    console.warn(
      `[modelscope-magicube] invalid probeIntervalDays ${String(configRef.probeIntervalDays)}, falling back to ${DEFAULT_PROBE_INTERVAL_DAYS}`,
    )
  }

  assertCredentialKey(TOKEN_KEY)
  assertCredentialKey(COOKIE_KEY)

  console.log(
    `[modelscope-magicube] loaded (dailyTime=${effectiveSettings.dailyTime}, likeCount=${effectiveSettings.likeCount}, openBrowser=${effectiveSettings.openBrowser}, probeIntervalDays=${effectiveSettings.probeIntervalDays})`,
  )

  /** 点赞运行互斥标记：调度 tick 与手动 runNow 共用，同一时刻最多一次点赞任务。 */
  let running = false
  /** 探测互斥标记：调度 tick 与手动 probeNow 共用；与点赞两把锁独立，互不阻塞。 */
  let probing = false
  /** editor 缺席/写入失败时的内存兜底：奖励页当日已尝试 / 探测当日已完成。 */
  let browserOpenDateMemory = ''
  let probeDateMemory = ''
  /** editor 缺席时的探测摘要内存兜底（getStatus 兜底展示用，进程内有效）。 */
  let probeSummaryMemory = null

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

  //#region 每日奖励页打开（0.3.0 新增）
  /** 奖励页 URL：配置了自定义 openUrl → 用之；否则「我的概览」页（profile/{name} 页 2026-11-26 起无法访问，弃用）。 */
  function resolveRewardUrl() {
    return effectiveSettings.openUrl !== '' ? effectiveSettings.openUrl : MY_OVERVIEW_URL
  }

  /** 当天是否已经尝试过打开（volatile 字段与内存兜底任一命中即算）。 */
  function browserOpenedToday(today) {
    return readVolatileString(configRef.lastBrowserOpenDate) === today || browserOpenDateMemory === today
  }

  /**
   * 把「今天已尝试打开」经 editor.edit 合并写进 volatile lastBrowserOpenDate（不重启）。
   * editor 缺席/写入失败 → 内存标记 + console.warn：门控不能丢，否则同一天的每一次
   * 互动都会开一次浏览器。
   */
  async function persistBrowserGate(today) {
    const { editor, entry } = resolveEditor()
    if (editor === undefined || editor === null || entry === undefined || entry === null) {
      browserOpenDateMemory = today
      console.warn('[modelscope-magicube] configEditor/fiber.entry unavailable, browser-open gate kept in memory only')
      return false
    }
    try {
      await editor.edit(entry, (current) => {
        const base = current !== null && typeof current === 'object' ? current : {}
        return { ...base, lastBrowserOpenDate: today }
      })
      return true
    } catch (error) {
      browserOpenDateMemory = today
      console.warn(`[modelscope-magicube] persisting browser-open gate failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * 当天首次互动时打开奖励页。门控在打开之前检查；打开失败也落门控（「每天最多
   * 一次」按尝试计，失败重试交给第二天的调度或用户手动操作）。打开失败只记日志，
   * 绝不影响点赞；本函数自身绝不 reject。
   */
  async function openRewardBrowserOnce(today, userName) {
    try {
      if (!effectiveSettings.openBrowser) return { attempted: false }
      if (browserOpenedToday(today)) return { attempted: false }
      const url = resolveRewardUrl()
      let opened = false
      try {
        opened = (await openUrlImpl(url)) === true
      } catch (error) {
        console.error(`[modelscope-magicube] openUrlImpl threw: ${error instanceof Error ? error.message : String(error)}`)
        opened = false
      }
      if (opened) {
        console.log(`[modelscope-magicube] reward page open requested: ${url}`)
      } else {
        console.error(`[modelscope-magicube] reward page open failed (likes unaffected): ${url}`)
      }
      await persistBrowserGate(today)
      return { attempted: true, opened, url }
    } catch (cause) {
      console.error(`[modelscope-magicube] reward open crashed: ${cause instanceof Error ? cause.message : String(cause)}`)
      return { attempted: false }
    }
  }
  //#endregion

  //#region 模型可用性探测（0.3.0 新增）
  /** MODELSCOPE_API_KEY 引用解析：有值返回 trim 后的值（绝不进日志/RPC/UI），否则空串。 */
  async function resolveInferenceApiKey() {
    try {
      const credentials = ctx.credentials
      if (credentials === null || typeof credentials !== 'object' || typeof credentials.resolve !== 'function') return ''
      const resolved = await credentials.resolve('MODELSCOPE_API_KEY')
      return resolved !== null && typeof resolved === 'object' && typeof resolved.value === 'string' && resolved.value.trim() !== ''
        ? resolved.value.trim()
        : ''
    } catch {
      return ''
    }
  }

  /** 探测是否到期：从未探测过，或「今天 − 上次探测 ≥ 间隔天数」。坏日期按到期处理。 */
  function probeDue(today) {
    const stored = readVolatileString(configRef.lastProbeDate)
    const last = stored !== '' ? stored : probeDateMemory
    if (last === '') return true
    const lastMs = dateStampToMs(last)
    const todayMs = dateStampToMs(today)
    if (lastMs === null || todayMs === null) return true
    return Math.round((todayMs - lastMs) / 86_400_000) >= effectiveSettings.probeIntervalDays
  }

  /**
   * 探测主体。返回摘要对象（JSON 持久化进 volatile lastProbeSummary），形状：
   *   { date, trigger, startedAt, finishedAt, ok, error, note, total,
   *     availableCount, unavailableCount, removedCount, errorCount,
   *     missingModels:[id…], groups:[{category, models:[{id, status, reason}]}] }
   * ok=false 仅表示探测本身没跑完（如可推理清单拉取失败）；「未找到已添加模型」
   * 是正常收场（ok=true + note），不报错。绝不抛出。
   */
  async function executeProbe({ trigger, today, startedAt }) {
    const base = {
      date: today,
      trigger,
      startedAt,
      ok: false,
      error: null,
      note: null,
      total: 0,
      availableCount: 0,
      unavailableCount: 0,
      removedCount: 0,
      errorCount: 0,
      missingModels: [],
      groups: [],
      finishedAt: null,
    }
    try {
      // a) profile 补丁层：读不到不报错，记 note 后收场。
      const configuredIds = readConfiguredModelIds()
      if (configuredIds === null || configuredIds.length === 0) {
        console.log('[modelscope-magicube] probe: no configured modelscope models found in profile patch (nothing to do)')
        return { ...base, ok: true, note: '未找到已添加的 ModelScope 模型', finishedAt: new Date(now()).toISOString() }
      }
      console.log(`[modelscope-magicube] probe: ${configuredIds.length} configured model(s) from profile patch`)
      // b) 可推理清单：匿名可读；凭据库解析到 MODELSCOPE_API_KEY 则带 Bearer（值绝不进日志）。
      const apiKey = await resolveInferenceApiKey()
      const listHeaders = apiKey !== '' ? { authorization: 'Bearer ' + apiKey } : {}
      const listAttempt = await requestJson(fetchImpl, INFERENCE_MODELS_URL, { method: 'GET', headers: listHeaders })
      const inferIds = listAttempt.status === 200 ? inferenceIdsOf(listAttempt.json) : null
      if (inferIds === null) {
        const cause = listAttempt.status === 0 ? `网络错误：${listAttempt.cause ?? '未知原因'}` : `HTTP ${listAttempt.status}`
        return { ...base, error: `获取可推理模型清单失败（${cause}）`, finishedAt: new Date(now()).toISOString() }
      }
      console.log(`[modelscope-magicube] probe: inference list has ${inferIds.size} servable model(s)`)
      // c) 两级判定 + 分类。详情请求对全部已配置模型都发：既做确认，也为分组拿分类
      //    （对在推理清单里的模型，详情结果不改变「可用」判定）。
      const results = []
      for (const id of configuredIds) {
        const parts = splitModelId(id)
        let status
        let reason = null
        let category = null
        if (parts === null) {
          if (inferIds.has(id)) {
            status = '可用'
          } else {
            status = '详情确认失败'
            reason = '模型 id 缺少 namespace/name 两段，无法确认详情'
          }
        } else {
          const detail = await requestJson(
            fetchImpl,
            `${MODELS_BASE_URL}/${encodeURIComponent(parts.namespace)}/${encodeURIComponent(parts.name)}`,
            { method: 'GET', headers: { 'content-type': 'application/json' } },
          )
          category = detailCategoryOf(detail.json)
          const code = detail.json !== null && typeof detail.json === 'object' && typeof detail.json.Code === 'number' ? detail.json.Code : null
          if (inferIds.has(id)) {
            status = '可用'
          } else if (detail.status === 404 && code === MODEL_REMOVED_CODE) {
            status = '已下架'
          } else if (detail.status === 200) {
            status = '推理不可用'
            reason = '模型存在但不在可推理清单中（可能为 gated 模型）'
          } else {
            status = '详情确认失败'
            reason = detail.status === 0 ? `网络错误：${detail.cause ?? '未知原因'}` : `HTTP ${detail.status}`
          }
        }
        results.push({ id, status, reason, category: category ?? '其他' })
        console.log(`[modelscope-magicube] probe: ${id} → ${status}${reason === null ? '' : ` (${reason})`}`)
      }
      // 分组（保持分类首次出现的顺序）。
      const groups = []
      const byCategory = new Map()
      for (const result of results) {
        let group = byCategory.get(result.category)
        if (group === undefined) {
          group = { category: result.category, models: [] }
          byCategory.set(result.category, group)
          groups.push(group)
        }
        group.models.push({ id: result.id, status: result.status, reason: result.reason })
      }
      const countOf = (wanted) => results.filter((result) => result.status === wanted).length
      const removedCount = countOf('已下架')
      const summary = {
        ...base,
        ok: true,
        total: results.length,
        availableCount: countOf('可用'),
        unavailableCount: countOf('推理不可用'),
        removedCount,
        errorCount: countOf('详情确认失败'),
        missingModels: results.filter((result) => result.status === '已下架').map((result) => result.id),
        groups,
        finishedAt: new Date(now()).toISOString(),
      }
      console.log(
        `[modelscope-magicube] probe done: total=${summary.total}, available=${summary.availableCount}, unavailable=${summary.unavailableCount}, removed=${removedCount}, error=${summary.errorCount}`,
      )
      return summary
    } catch (cause) {
      // 兜底：探测永不抛出；意外收敛为摘要错误（只影响探测状态，不影响点赞）。
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`[modelscope-magicube] probe crashed: ${message}`)
      return { ...base, error: `探测异常中断：${message}`, finishedAt: new Date(now()).toISOString() }
    }
  }

  /**
   * 把探测摘要写进 volatile（lastProbeDate + lastProbeSummary 合并原地更新，不重启）。
   * editor 缺席/写入失败 → 内存标记 + console.warn：调度门控不能丢，否则 editor
   * 缺席时每 60s 都会重新探测。
   */
  async function persistProbeSummary(today, summary) {
    const { editor, entry } = resolveEditor()
    if (editor === undefined || editor === null || entry === undefined || entry === null) {
      probeDateMemory = today
      probeSummaryMemory = summary
      console.warn('[modelscope-magicube] configEditor/fiber.entry unavailable, probe result kept in memory only')
      return false
    }
    try {
      await editor.edit(entry, (current) => {
        const base = current !== null && typeof current === 'object' ? current : {}
        return { ...base, lastProbeDate: today, lastProbeSummary: JSON.stringify(summary) }
      })
      console.log(`[modelscope-magicube] probe result persisted (lastProbeDate=${today})`)
      return true
    } catch (error) {
      probeDateMemory = today
      probeSummaryMemory = summary
      console.warn(`[modelscope-magicube] persisting probe result failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 一次探测的完整闭环：互斥 → 执行 → 持久化。与点赞互不阻塞，绝不 reject。 */
  async function runProbe(trigger) {
    if (probing) return
    probing = true
    const startedClock = new Date(now())
    const today = dateStampOf(startedClock)
    try {
      console.log(
        `[modelscope-magicube] probe start (trigger=${trigger}, date=${today}, intervalDays=${effectiveSettings.probeIntervalDays})`,
      )
      const summary = await executeProbe({ trigger, today, startedAt: startedClock.toISOString() })
      await persistProbeSummary(today, summary)
    } catch (cause) {
      // executeProbe 内部已兜底；这里只防 persistProbeSummary 之外的意外。
      console.error(`[modelscope-magicube] probe failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      probing = false
    }
  }
  //#endregion

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
      // 奖励页打开随本次互动走（fire-and-forget，绝不阻塞点赞；函数内部吞掉一切错误）。
      const openReward = (userName) => {
        void openRewardBrowserOnce(today, userName)
      }
      // —— 凭据门：点赞必须用完整 Cookie；令牌只服务余额组件，这里只读不作鉴权 ——
      const cookie = await readSecret(COOKIE_KEY, 'cookie')
      const token = await readSecret(TOKEN_KEY, 'token')
      if (token !== '') {
        console.log('[modelscope-magicube] access token present; likes still use the session cookie (token cannot like)')
      }
      if (cookie === '') {
        openReward('')
        return finalize({
          liked: [],
          failed: [],
          interrupted: null,
          error: '未配置会话 Cookie：点赞必须使用完整 Cookie（仅访问令牌不可点赞），请在「ModelScope 魔粒余额」组件页填写',
        })
      }
      const csrfToken = extractCsrfToken(cookie)
      if (csrfToken === '') {
        openReward('')
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
        openReward('')
        return finalize({ liked: [], failed: [], interrupted: 'cookie', error: `Cookie 已失效（users/info 返回 HTTP ${whoami.status}）` })
      }
      if (whoami.status !== 200) {
        const cause = whoami.status === 0 ? `网络错误：${whoami.cause ?? '未知原因'}` : `HTTP ${whoami.status}`
        openReward('')
        return finalize({ liked: [], failed: [], interrupted: null, error: `读取用户信息失败（${cause}）` })
      }
      const whoamiParsed = parseEnvelope(whoami.json)
      if (!whoamiParsed.ok) {
        openReward('')
        return finalize({ liked: [], failed: [], interrupted: null, error: `读取用户信息失败：${whoamiParsed.message}` })
      }
      const userName =
        whoamiParsed.data !== null && typeof whoamiParsed.data === 'object' && typeof whoamiParsed.data.user_name === 'string'
          ? whoamiParsed.data.user_name
          : ''
      if (userName === '') {
        openReward('')
        return finalize({ liked: [], failed: [], interrupted: null, error: '用户信息响应缺少 user_name' })
      }
      console.log(`[modelscope-magicube] whoami ok: user_name=${userName}`)
      // user_name 到手（用于排除本人模型）：奖励页打开在点赞开始前发出，绝不阻塞后续点赞。
      openReward(userName)

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
   * Cookie 中断后的「凭据是否全军覆没」判定（0.4.0 弹窗策略，用户拍板：仅两者都
   * 失效才弹「凭据全部失效」；令牌仍被余额接口认可 → 静默，用户从余额 chip 自己
   * 会注意到 Cookie 挂了）。网络问题按 false（不弹）处理——不误报。
   * 密钥值绝不进日志。
   */
  async function bothCredentialsDeadNow() {
    try {
      const hit =
        ctx.credentials !== null &&
        typeof ctx.credentials === 'object' &&
        typeof ctx.credentials.resolve === 'function'
          ? await ctx.credentials.resolve(MODELSCOPE_API_KEY_REF)
          : undefined
      const key = hit !== null && typeof hit === 'object' && typeof hit.value === 'string' ? hit.value.trim() : ''
      if (key === '') return true
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), 15000)
      try {
        const response = await fetchImpl(BALANCE_URL, {
          headers: {
            authorization: 'Bearer ' + key,
            'x-modelscope-trace-id': traceId(),
            'x-modelscope-accept-language': 'zh-CN',
          },
          signal: controller.signal,
        })
        let json = null
        try {
          json = await response.json()
        } catch {
          json = null
        }
        // success:true → 令牌有效（静默）；其余（401/code 含 auth 等）→ 令牌也失效 → 弹。
        return !(json !== null && typeof json === 'object' && json.success === true)
      } finally {
        clearTimeout(timer)
      }
    } catch (cause) {
      console.error(`[modelscope-magicube] key liveness check failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      return false
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
      // 0.4.0 弹窗策略：Cookie 中断时计算「令牌是否也失效」，供客户端决定是否弹
      // 「凭据全部失效」；非 Cookie 路径不带该字段（undefined = 不适用）。
      if (summary.interrupted === 'cookie') {
        summary.bothCredentialsDead = await bothCredentialsDeadNow()
      }
      await persistSummary(today, summary)
    } catch (cause) {
      // executeRun 内部已兜底；这里只防 persistSummary 之外的意外。
      console.error(`[modelscope-magicube] run failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      running = false
    }
  }

  /**
   * 调度检查（60s 一次，点赞与探测共用同一条 tick，两把互斥锁独立、互不阻塞）：
   *   - 点赞：过了今日 dailyTime 且今天没跑过 → 启动点赞任务（天然补跑）；
   *   - 探测：距上次探测 ≥ probeIntervalDays → 启动探测（探测错误只影响探测状态）。
   */
  function tick() {
    const clock = new Date(now())
    const today = dateStampOf(clock)
    // —— 点赞调度（逻辑与 0.2.x 相同） ——
    const lastRunDate = readVolatileString(configRef.lastRunDate)
    if (lastRunDate !== today) {
      const currentMinutes = clock.getHours() * 60 + clock.getMinutes()
      if (currentMinutes >= minutesOfDay(effectiveSettings.dailyTime)) {
        console.log(`[modelscope-magicube] tick: past ${effectiveSettings.dailyTime} on ${today} and not run yet — starting daily task`)
        void runDailyTask('schedule')
      }
    }
    // —— 探测调度 ——
    if (!probing && probeDue(today)) {
      const lastProbeDate = readVolatileString(configRef.lastProbeDate) !== '' ? readVolatileString(configRef.lastProbeDate) : probeDateMemory
      console.log(
        `[modelscope-magicube] tick: probe due (lastProbeDate=${lastProbeDate === '' ? '(never)' : lastProbeDate}, intervalDays=${effectiveSettings.probeIntervalDays}) — starting probe`,
      )
      void runProbe('schedule')
    }
  }

  /** RPC 处理器：三端点，payload 只含设置与布尔状态，绝不回显凭据。 */
  const handler = async (endpoint, rawPayload) => {
    switch (endpoint) {
      case 'getStatus': {
        const cookie = await readSecret(COOKIE_KEY, 'cookie')
        const token = await readSecret(TOKEN_KEY, 'token')
        const lastRunDate = readVolatileString(configRef.lastRunDate)
        // 0.3.0：探测状态（向后兼容：旧字段一律不动，只新增 probe/openBrowser/openUrl）。
        const lastProbe = parseSummary(readVolatileString(configRef.lastProbeSummary)) ?? probeSummaryMemory
        const missingCount =
          lastProbe !== null && Number.isInteger(lastProbe.removedCount) && lastProbe.removedCount > 0 ? lastProbe.removedCount : 0
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
            // —— 以下为 0.3.0 新增字段 ——
            openBrowser: effectiveSettings.openBrowser,
            openUrl: effectiveSettings.openUrl,
            popupNotify: effectiveSettings.popupNotify,
            probe: {
              intervalDays: effectiveSettings.probeIntervalDays,
              lastProbeDate: readVolatileString(configRef.lastProbeDate) !== '' ? readVolatileString(configRef.lastProbeDate) : probeDateMemory,
              lastProbe,
              probing,
              missingCount,
            },
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
      case 'probeNow': {
        // 手动探测：与点赞互不阻塞（两把锁独立），探测互斥不变。
        if (probing) {
          return { ok: false, error: { code: 'internal', message: '已有一次探测在运行，请等它完成后再试', details: {} } }
        }
        console.log('[modelscope-magicube] manual probe requested via RPC')
        void runProbe('manual')
        return { ok: true, value: { started: true, probing: true } }
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
        // 0.3.0：openBrowser/openUrl/probeIntervalDays 并入 saveSettings。载荷载荷缺
        // 字段时保持现行配置不变（旧版 client 只传 dailyTime/likeCount，不能把用户的
        // 新配置清回默认值）。
        const openBrowser = typeof payloadBody.openBrowser === 'boolean' ? payloadBody.openBrowser : configRef.openBrowser !== false
        const openUrl =
          typeof payloadBody.openUrl === 'string'
            ? payloadBody.openUrl.trim()
            : typeof configRef.openUrl === 'string'
              ? configRef.openUrl.trim()
              : ''
        if (openUrl !== '' && !/^https?:\/\//i.test(openUrl)) {
          problems.push('自定义打开地址必须以 http:// 或 https:// 开头（留空使用「我的概览」页）')
        }
        let probeIntervalDays
        if (payloadBody.probeIntervalDays !== undefined) {
          const rawDays = Number(payloadBody.probeIntervalDays)
          if (!Number.isInteger(rawDays) || rawDays < 1) {
            problems.push('探测间隔必须是 ≥1 的整数（天）')
          } else {
            probeIntervalDays = rawDays
          }
        } else {
          const rawCurrent = Number(configRef.probeIntervalDays)
          probeIntervalDays = Number.isInteger(rawCurrent) && rawCurrent >= 1 ? rawCurrent : DEFAULT_PROBE_INTERVAL_DAYS
        }
        const popupNotify = typeof payloadBody.popupNotify === 'boolean' ? payloadBody.popupNotify : configRef.popupNotify !== false
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
            return { ...base, dailyTime, likeCount, openBrowser, openUrl, probeIntervalDays, popupNotify }
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
        console.log(
          `[modelscope-magicube] settings saved (dailyTime=${dailyTime}, likeCount=${likeCount}, openBrowser=${openBrowser}, openUrl=${openUrl === '' ? '(default)' : openUrl}, probeIntervalDays=${probeIntervalDays}); ordinary fields apply after the plugin restarts`,
        )
        return { ok: true, value: { dailyTime, likeCount, openBrowser, openUrl, probeIntervalDays } }
      }
      default:
        return { ok: false, error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} } }
    }
  }

  mountRpcChannel(ctx, CHANNEL, handler, MAX_BODY_BYTES)

  // 调度进 effect：disposer 真停表，不泄漏 interval。先立即 tick 一次——
  // 插件在每日时间之后启动（宿主刚开机/组件刚启用）时当场补跑。
  ctx.effect(() => {
    console.log(
      `[modelscope-magicube] scheduler started (intervalMs=${TICK_MS}, dailyTime=${effectiveSettings.dailyTime}, likeCount=${effectiveSettings.likeCount}, probeIntervalDays=${effectiveSettings.probeIntervalDays})`,
    )
    tick()
    const timer = setInterval(() => tick(), TICK_MS)
    if (typeof timer?.unref === 'function') timer.unref()
    return () => {
      clearInterval(timer)
      console.log('[modelscope-magicube] scheduler stopped')
    }
  }, 'dsh-modelscope-pts/magicube: daily scheduler')
}
