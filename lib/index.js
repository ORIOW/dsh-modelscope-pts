/**
 * dsh-modelscope-pts — host half.
 *
 * 职责：按「访问令牌优先、失败回退会话 Cookie」的凭据策略，从 ModelScope 的
 * openapi 网关拉取账号魔粒（积分）余额，把结果留在内存缓存里，经一条 loopback
 * RPC 通道暴露给浏览器半身。
 *
 * 为什么沿用「host 轮询 + client 读缓存」而不是 client 直接拉上游：
 *   - 凭据存在 host 侧的 ctx.credentials 里，浏览器半身拿不到也不该拿到
 *    （令牌/Cookie 绝不越过 RPC 边界，client 只见布尔状态与数值）；
 *   - 轮询节奏集中在一处（ctx.effect 管理清理），client 的 60s 定时只是读缓存，
 *     不会造成请求放大。
 *
 * 上游接口（任务单 2026-11-18-001 已核实，勿改）：
 *   GET https://www.modelscope.cn/openapi/v1/magicubes/balance
 *   - openapi 网关小写信封：{ success, request_id, data: { total_balance,
 *     available_balance, frozen_amount, is_disabled } }，与 /api/v1 的大写
 *     Code/Data 信封是两套，解析不得混用。
 *   - Cookie 鉴权；`Authorization: Bearer <ms-…>` 是否被网关接受未验证，
 *     因此令牌失败必须按本文件的策略回退 Cookie（用户已决策：两者都支持）。
 *
 * 两个沿用参考实现（dsh-amd-model-load）踩坑结论的写法：
 *   1. `ctx.logger.info` 永不进 harness.log（log-bridge 只放行 error/warn），
 *      留痕必须 `console.log` / `console.error`。
 *   2. RPC 路由必须 `ctx.inject(['connection','webServer'], cb)` 延迟注册：
 *      组合期 carrier 未起，直接 ctx.get 得到 undefined，路由会静默消失。
 *
 * RPC 契约（照抄 dsh-amd-model-load 的 mountRpcChannel，其源自 dsh-pause）：
 *   请求  POST <channel>/<method>  content-type: application/json
 *         {type:"client-request", rpcId, method, payload}
 *   响应  {type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error:{...}}}
 *   信任  connection.requestRejection(req) === undefined 才放行
 *   method 必须等于路径末段，否则回 gateway/bad-request
 *
 * 密钥纪律（任务单 2026-11-18-002 硬约束）：
 *   - 令牌/Cookie 只经 ctx.credentials.modifyRecord 存取，不进 Config，
 *     不出现在任何日志与 RPC 返回值里；RPC 只返回「已配置/未配置」布尔。
 *   - 凭据记录键 <owner>/<id> 按 @deepseek-ai/dsh-credentials 的文法手拼：
 *     两段都必须匹配 /^[a-z][a-z0-9-]*$/（credentialKey 的运行时实现是
 *     brandString —— 原样返回字符串，brand 只存在于类型层，因此手拼键与
 *     credentialKey 产物在运行时逐字节相同；此处不 import 该包，避免给
 *     host 半身增加一个硬模块依赖）。
 *
 * @module dsh-modelscope-pts
 */
import z from '@deepseek-ai/schemastery'

/** 插件名即配置项 id，与 cordis.patch.yml 里的 name 一致。 */
export const name = 'dsh-modelscope-pts'

/**
 * 本插件依赖的服务。
 *
 * `credentials` 按 host-plugin.md 的指引显式声明（密钥存取走 ctx.credentials）。
 * connection/webServer 在组合期未就绪，由 mountRpcChannel 里的
 * ctx.inject(['connection','webServer'], …) 延迟注册，不放进这里。
 */
export const inject = ['credentials']

/** 魔粒余额端点。openapi 网关前缀，仅此一条可用（/api 前缀与尾斜杠实测 404）。 */
export const BALANCE_URL = 'https://www.modelscope.cn/openapi/v1/magicubes/balance'

/** RPC 通道前缀。client 侧必须以同一个字符串调用。 */
export const CHANNEL = '/dsh-modelscope-pts'

/** 凭据记录键。owner 段 = 插件注册名，id 段自选；两段都匹配 KEY_SEGMENT 文法。 */
const TOKEN_KEY = name + '/' + 'modelscope-token'
const COOKIE_KEY = name + '/' + 'modelscope-cookie'

/**
 * 凭据键两段的合法文法，与 @deepseek-ai/dsh-credentials 的
 * KEY_SEGMENT_PATTERN 一致。模块加载时自检一次，键拼错直接炸出来。
 */
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/

/** 请求体上限。本通道最大载荷是 saveCredentials 的令牌+Cookie 文本，64 KiB 足够。 */
const MAX_BODY_BYTES = 65_536

/** 刷新间隔下限（毫秒），与 Config 的 .min 对齐；apply 里再 clamp 一次双保险。 */
const MIN_REFRESH_MS = 10_000

/** 部署侧配置。⚠️ 不含任何密钥字段 —— 令牌与 Cookie 走 ctx.credentials。 */
export const Config = z.object({
  /** 总开关。false 时 apply 直接返回，不挂 RPC、不起定时器。 */
  enabled: z.boolean().default(true),
  /**
   * host 侧刷新间隔（毫秒），下限 10000：魔粒是低频变动数据
   * （实测数分钟内 261→265），更密只会给网关徒增请求。
   */
  refreshIntervalMs: z.number().min(MIN_REFRESH_MS).default(60_000),
  /** 单次上游请求超时（毫秒）。接口实测毫秒级，15s 已非常宽。 */
  timeoutMs: z.number().min(1_000).default(15_000),
  /** 是否在模型选择列表的模型行旁显示魔粒徽章。 */
  showInModelSelector: z.boolean().default(true),
  /**
   * 是否在插件行配置页显示余额面板。凭据表单不受它影响 —— 该页是唯一的
   * 凭据入口，关掉展示位不能把用户锁在门外。
   */
  showInPluginRow: z.boolean().default(true),
})

//#region 凭据键与凭据读取
/** 校验凭据键两段，防手拼笔误在存储层炸出难懂的错。 */
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
//#endregion

//#region rpc channel（形状照抄 dsh-amd-model-load 的 mountRpcChannel / serve / reply）
/** 端点路径段的合法字符集，与官方 ENDPOINT_SEGMENT_PATTERN 一致。 */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** 唯一接受的 content-type，与官方信封契约一致。 */
const JSON_MIME = 'application/json'

/** 请求体超限的标记错误，由 serve 决定如何回写与断开。 */
class PayloadTooLargeError extends Error {}

/**
 * 挂载 RPC 通道。webServer 或 connection 缺席时不挂载，插件其余功能不受影响。
 *
 * @param ctx - 插件上下文。
 * @param channel - 绝对通道前缀。
 * @param handler - `(endpoint, payload) => Promise<result>`，result 已是 `{ok,...}` 信封。
 * @param maxBodyBytes - 请求体上限。
 */
function mountRpcChannel(ctx, channel, handler, maxBodyBytes) {
  // 必须延迟注册：组合期 webServer 还没起，ctx.get 会拿到 undefined，
  // 而 register 一个 undefined 不会报错，路由就此静默消失。
  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'prefix',
          path: channel,
          handler: (req, res) => serve(scope.connection, channel, handler, maxBodyBytes, req, res),
        }),
      `${channel}: rpc channel`,
    )
  })
}

/**
 * 处理一次 HTTP 请求：信任判定、端点解析、信封校验、结果回写。
 *
 * @param connection - connection 服务，用其信任判定。
 * @param channel - 本通道前缀。
 * @param handler - 端点处理器。
 * @param maxBodyBytes - 请求体上限。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function serve(connection, channel, handler, maxBodyBytes, req, res) {
  // 非 loopback / 非受信来源：requestRejection 返回数字，原样回写并断开。
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') return missing(res)

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const prefix = `${channel}/`
  if (!pathname.startsWith(prefix)) return missing(res)
  const endpoint = pathname.slice(prefix.length)
  if (!endpoint.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT.test(part))) {
    return missing(res)
  }

  if (!isJsonContentType(req)) {
    res.writeHead(415)
    res.end('unsupported media type')
    return
  }

  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBodyBytes) return tooLarge(req, res)

  let raw
  try {
    raw = await readBody(req, maxBodyBytes)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return tooLarge(req, res)
    res.writeHead(400)
    res.end('body read failed')
    return
  }

  let message
  try {
    message = JSON.parse(raw)
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }

  const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
  if (message.type !== 'client-request' || typeof message.method !== 'string') {
    return reply(res, rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
    })
  }
  if (message.method !== endpoint) {
    return reply(res, rpcId, {
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: {},
      },
    })
  }

  const controller = new AbortController()
  const onClose = () => {
    controller.abort(new Error('client disconnected'))
  }
  res.on('close', onClose)

  let result
  try {
    result = await handler(endpoint, message.payload, controller.signal)
  } catch (error) {
    result = {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
    }
  } finally {
    res.off('close', onClose)
  }
  reply(res, rpcId, result)
}

/** 路径不匹配或方法不符时统一 404，与官方未认领端点一致。 */
function missing(res) {
  res.writeHead(404)
  res.end('not found')
}

/** 回写一个 server-response 信封。 */
function reply(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** 先回 413 再销毁连接：顺序反了 socket 已断，413 永远发不出去。 */
function tooLarge(req, res) {
  res.writeHead(413, { connection: 'close' })
  res.end('payload too large')
  req.destroy()
}

/** content-type 必须声明为 application/json，charset 等参数可忽略。 */
function isJsonContentType(req) {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return false
  const mime = header.split(';', 1)[0]
  return mime !== undefined && mime.trim().toLowerCase() === JSON_MIME
}

/** 读取并限长请求体，超限抛 PayloadTooLargeError，由调用方回写 413。 */
async function readBody(req, maxBodyBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > maxBodyBytes) throw new PayloadTooLargeError('rpc channel: request body exceeds limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
//#endregion

//#region 余额源（缓存 + 凭据策略 + 上游拉取）
/** 每次请求生成唯一 trace id；服务端会把它回显进响应的 request_id。 */
let traceCounter = 0
function traceId() {
  traceCounter = (traceCounter + 1) % Number.MAX_SAFE_INTEGER
  return 'dsh-pts-' + Date.now().toString(36) + '-' + traceCounter.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** 一次上游请求的结果。status 0 表示请求本身没到达网关（网络错误/超时）。 */
function parseEnvelope(json) {
  // openapi 网关小写信封。大写 Code/Data 是 /api/v1 的另一套信封，不在这里判。
  if (json === null || typeof json !== 'object') return { ok: false, code: '', message: '响应不是 JSON 对象' }
  if (json.success === true) {
    const data = json.data
    if (data === null || typeof data !== 'object') return { ok: false, code: '', message: '响应缺少 data 字段' }
    const numberOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    return {
      ok: true,
      available: numberOf(data.available_balance),
      total: numberOf(data.total_balance),
      frozen: numberOf(data.frozen_amount),
      disabled: data.is_disabled === true,
    }
  }
  return {
    ok: false,
    code: typeof json.code === 'string' ? json.code : '',
    message: typeof json.message === 'string' && json.message !== '' ? json.message : '请求被网关拒绝',
  }
}

/** 鉴权失败判定：401/403 状态，或网关返回的 code 带有 auth 字样（InvalidAuthentication 等）。 */
function isAuthFailure(status, code) {
  if (status === 401 || status === 403) return true
  return typeof code === 'string' && code.toLowerCase().includes('auth')
}

/** 把一次失败尝试压成给用户看的错误文案（不含任何凭据信息）。 */
function describeFailure(label, attempt, parsed) {
  if (attempt.status === 0) return `${label}请求失败（网络错误：${attempt.cause ?? '未知原因'}）`
  const codePart = parsed.code !== '' ? `，code=${parsed.code}` : ''
  const messagePart = parsed.message !== '' ? `：${parsed.message}` : ''
  return `${label}请求失败（HTTP ${attempt.status}${codePart}${messagePart}）`
}

/**
 * 创建余额源：内存缓存 + 凭据策略 + 上游拉取。
 *
 * 缓存语义（与参考实现的轮询器一致）：
 *   - 成功后缓存 data 与 lastSuccessTs；失败只更新 error，data 原样保留；
 *   - ensureFresh() 在「缓存为空或数据已旧于 refreshIntervalMs」时才真正发请求，
 *     in-flight 请求全局去重 —— client 的轮询与 host 的定时器不会请求放大；
 *   - payload().stale = 数据已旧于两个刷新周期，供 UI 标「陈旧」。
 *
 * @param options.ctx - 插件上下文（读 ctx.credentials）。
 * @param options.timeoutMs - 单次上游请求超时。
 * @param options.refreshIntervalMs - 数据新鲜度阈值。
 * @param options.fetchImpl - fetch 实现（测试注入点）。
 */
function createBalanceSource({ ctx, timeoutMs, refreshIntervalMs, fetchImpl }) {
  // forced：凭据变更后的「下一次必拉」标记。与 lastSuccessTs 分离 ——
  // 旧数据仍要带着它自己的时间戳展示，不能为了强制刷新就把 ts 打成 0。
  const cache = { data: null, lastSuccessTs: 0, error: null, inFlight: null, forced: false }

  /** 读取一条凭据记录的指定字段。只返回值本身给本闭包，绝不进日志。 */
  async function readSecret(key, field) {
    try {
      const record = await ctx.credentials.readRecord(key)
      return secretOf(record, field)
    } catch (error) {
      // 只记错误形态，不记值 —— 密钥纪律。
      console.error(`[modelscope-pts] read credential ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** 发一次上游 GET。永不 reject：网络错误也返回 {status:0}，让策略层统一处理。 */
  async function doFetch(headers) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const response = await fetchImpl(BALANCE_URL, { method: 'GET', headers, signal: controller.signal })
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return { status: response.status, json, cause: null }
    } catch (cause) {
      const message =
        controller.signal.aborted
          ? 'timeout'
          : cause instanceof Error
            ? cause.message
            : String(cause)
      return { status: 0, json: null, cause: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 凭据策略（任务单 2026-11-18-002 用户决策，硬约束）：
   *   1. 配了令牌 → 先用 Bearer 请求；成功即用；
   *   2. 令牌鉴权失败（401/403/InvalidAuthentication）且配了 Cookie → 回退 Cookie；
   *   3. 只配 Cookie → 直接用 Cookie；
   *   4. 两者都没配 → 返回明确错误，不发请求。
   * 非鉴权失败（网络错误/5xx）不回退 —— Cookie 回退只为鉴权失效兜底。
   */
  async function fetchOnce() {
    const token = await readSecret(TOKEN_KEY, 'token')
    const cookie = await readSecret(COOKIE_KEY, 'cookie')
    if (token === '' && cookie === '') {
      return { ok: false, error: '未配置凭据，请在插件设置中填写访问令牌或会话 Cookie' }
    }
    // trace id 每次请求单独生成：令牌与回退 Cookie 是两次独立请求，
    // 复用同一个 id 会让服务端把两段日志串错。
    const baseHeaders = {
      'content-type': 'application/json',
      'x-modelscope-accept-language': 'zh-CN',
    }

    let tokenAttempt = null
    if (token !== '') {
      tokenAttempt = await doFetch({ ...baseHeaders, 'x-modelscope-trace-id': traceId(), authorization: 'Bearer ' + token })
      const parsed = parseEnvelope(tokenAttempt.json)
      if (parsed.ok) return parsed
      // 令牌路径的失败：只有鉴权失败才值得用 Cookie 回退；其它错误原样上报。
      if (!isAuthFailure(tokenAttempt.status, parsed.code) || cookie === '') {
        return { ok: false, error: describeFailure('访问令牌', tokenAttempt, parsed) }
      }
    }

    const cookieAttempt = await doFetch({ ...baseHeaders, 'x-modelscope-trace-id': traceId(), cookie })
    const cookieParsed = parseEnvelope(cookieAttempt.json)
    if (cookieParsed.ok) return cookieParsed
    return { ok: false, error: describeFailure(token !== '' ? '回退 Cookie' : '会话 Cookie', cookieAttempt, cookieParsed) }
  }

  /** 拉一次上游并更新缓存；in-flight 去重。永不 reject。 */
  function ensureFresh() {
    if (cache.inFlight !== null) return cache.inFlight
    if (!cache.forced && cache.data !== null && Date.now() - cache.lastSuccessTs < refreshIntervalMs) return Promise.resolve()
    cache.inFlight = (async () => {
      const result = await fetchOnce()
      if (result.ok) {
        cache.data = { available: result.available, total: result.total, frozen: result.frozen, disabled: result.disabled }
        cache.lastSuccessTs = Date.now()
        cache.error = null
        cache.forced = false
        console.log(`[modelscope-pts] balance ok: available=${result.available}, total=${result.total}, frozen=${result.frozen}`)
      } else {
        // forced 保持 true：凭据刚换但还没成功拉到新数据，继续标陈旧并驱动重试。
        cache.error = result.error
        const kept = cache.data !== null ? ' (kept last success)' : ''
        console.error(`[modelscope-pts] balance failed: ${result.error}${kept}`)
      }
    })()
      .finally(() => {
        cache.inFlight = null
      })
    return cache.inFlight
  }

  /** 组装 RPC 返回值。stale/error 在每次调用时重算，不能缓存 —— 它们随时间推移而变。 */
  function payload() {
    const hasData = cache.data !== null
    return {
      // ok=false 表示当前没有可展示的余额；ok=true 时 error 仍可能非空
      //（旧数据 + 最近一次刷新失败），client 据此同时显示数字与失败原因。
      ok: hasData,
      available: hasData ? cache.data.available : null,
      total: hasData ? cache.data.total : null,
      frozen: hasData ? cache.data.frozen : null,
      disabled: hasData ? cache.data.disabled : false,
      error: cache.error ?? (hasData ? null : '尚未取得余额'),
      stale: hasData ? cache.forced || Date.now() - cache.lastSuccessTs > refreshIntervalMs * 2 : true,
      ts: hasData ? cache.lastSuccessTs : 0,
    }
  }

  /** 凭据状态（只回布尔，绝不回值）。 */
  async function credentialStatus() {
    const token = await readSecret(TOKEN_KEY, 'token')
    const cookie = await readSecret(COOKIE_KEY, 'cookie')
    return { hasToken: token !== '', hasCookie: cookie !== '' }
  }

  /**
   * 凭据变更后使缓存失效：保留旧数据与其时间戳供展示（stale 立刻变 true），
   * 下一次 ensureFresh 强制重拉。
   */
  function invalidate() {
    cache.forced = true
  }

  return { ensureFresh, payload, credentialStatus, invalidate }
}
//#endregion

/**
 * 装配 host 半身：挂 RPC 通道 + 起定时刷新。
 *
 * @param ctx - cordis 上下文。
 * @param config - 已解析的 Config。
 * @param deps - 测试注入点：`{ fetchImpl }` 替换全局 fetch，完全离线跑装配。
 */
export function apply(ctx, config, deps) {
  const enabled = config?.enabled ?? true
  if (!enabled) {
    console.log('[modelscope-pts] disabled by config, nothing mounted')
    return
  }
  const refreshIntervalMs = Math.max(MIN_REFRESH_MS, config?.refreshIntervalMs ?? 60_000)
  const timeoutMs = Math.max(1_000, config?.timeoutMs ?? 15_000)

  /**
   * 注入点：cordis 调 apply(ctx, config) 时 deps 为 undefined，走真实 fetch。
   * 单测传 `{fetchImpl}` 就能完全离线跑装配测试。
   */
  const fetchImpl = deps !== null && typeof deps === 'object' && typeof deps.fetchImpl === 'function'
    ? deps.fetchImpl
    : (...args) => globalThis.fetch(...args)

  // 打点必须走 console.log，不能走 ctx.logger.info：log-bridge 的 exporter 只放行 error/warn。
  console.log(`[modelscope-pts] host loaded (refreshIntervalMs=${refreshIntervalMs}, timeoutMs=${timeoutMs})`)

  // 凭据键在模块级只构建一次；这里再断言一次（键文法错误宁可早炸）。
  assertCredentialKey(TOKEN_KEY)
  assertCredentialKey(COOKIE_KEY)

  const source = createBalanceSource({ ctx, timeoutMs, refreshIntervalMs, fetchImpl })

  const handler = async (endpoint, rawPayload) => {
    switch (endpoint) {
      case 'fetchBalance': {
        // 缓存新鲜则毫秒级返回；缓存空/旧则等这次拉取完成再回。
        await source.ensureFresh()
        return { ok: true, value: source.payload() }
      }
      case 'getCredentialStatus':
        return { ok: true, value: await source.credentialStatus() }
      case 'saveCredentials': {
        const payloadBody = rawPayload !== null && typeof rawPayload === 'object' ? rawPayload : {}
        const token = typeof payloadBody.token === 'string' ? payloadBody.token.trim() : ''
        const cookie = typeof payloadBody.cookie === 'string' ? payloadBody.cookie.trim() : ''
        // 显式清除通道：非空值存储，空值不动，clearXxx=true 才删除。
        // 没有它，用户无法从「令牌+Cookie」退回「仅 Cookie」或撤销失效凭据。
        const clearToken = payloadBody.clearToken === true
        const clearCookie = payloadBody.clearCookie === true
        if (token === '' && cookie === '' && !clearToken && !clearCookie) {
          return {
            ok: false,
            error: { code: 'internal', message: '至少提供访问令牌或会话 Cookie 中的一项', details: {} },
          }
        }
        // modifyRecord 是唯一写路径；grant 记录只允许 kind + payload 两个字段。
        // deleteRecord 对不存在的记录是 no-op（文档语义）。
        // 返回值与日志只含「是否配置」，绝不回显原文。
        if (token !== '') {
          await ctx.credentials.modifyRecord(TOKEN_KEY, () => ({ kind: 'grant', payload: { token } }))
        } else if (clearToken) {
          await ctx.credentials.deleteRecord(TOKEN_KEY)
        }
        if (cookie !== '') {
          await ctx.credentials.modifyRecord(COOKIE_KEY, () => ({ kind: 'grant', payload: { cookie } }))
        } else if (clearCookie) {
          await ctx.credentials.deleteRecord(COOKIE_KEY)
        }
        console.log(
          `[modelscope-pts] credentials updated (token=${token !== '' ? 'set' : clearToken ? 'cleared' : 'kept'}, cookie=${cookie !== '' ? 'set' : clearCookie ? 'cleared' : 'kept'})`,
        )
        // 凭据变了，强制下一次拉取走新凭据；旧数据保留展示（stale 标记会亮）。
        source.invalidate()
        return { ok: true, value: await source.credentialStatus() }
      }
      case 'getConfig':
        // client 的唯一配置来源：轮询间隔与两个展示位开关。
        return {
          ok: true,
          value: {
            pollMs: refreshIntervalMs,
            showInModelSelector: config?.showInModelSelector !== false,
            showInPluginRow: config?.showInPluginRow !== false,
          },
        }
      default:
        return {
          ok: false,
          error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
        }
    }
  }

  mountRpcChannel(ctx, CHANNEL, handler, MAX_BODY_BYTES)

  // 定时刷新进 effect：disposer 真停表，不泄漏 interval。
  ctx.effect(() => {
    // 起表先预热一次缓存：首个 client 订阅者到来时不必等网络往返。
    void source.ensureFresh()
    const timer = setInterval(() => {
      void source.ensureFresh()
    }, refreshIntervalMs)
    if (typeof timer?.unref === 'function') timer.unref()
    console.log(`[modelscope-pts] refresh timer started (intervalMs=${refreshIntervalMs})`)
    return () => {
      clearInterval(timer)
      console.log('[modelscope-pts] refresh timer stopped')
    }
  }, 'dsh-modelscope-pts: refresh timer')
}
