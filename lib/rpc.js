/**
 * dsh-modelscope-pts — RPC 通道机制。
 *
 * 从 lib/index.js 原样迁出（2026-11-22-004，函数体逐字未动），供同一 bundle 里的
 * 两个组件共用：余额组件（lib/index.js）与每日魔粒互动组件（lib/magicube.js）
 * 各挂一条独立通道，但信封契约、信任判定与限长逻辑只有这一份。
 *
 * 契约（照抄 dsh-amd-model-load 的 mountRpcChannel，其源自 dsh-pause）：
 *   请求  POST <channel>/<method>  content-type: application/json
 *         {type:"client-request", rpcId, method, payload}
 *   响应  {type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error:{...}}}
 *   信任  connection.requestRejection(req) === undefined 才放行
 *   method 必须等于路径末段，否则回 gateway/bad-request
 *
 * @module dsh-modelscope-pts/rpc
 */

//#region rpc channel（形状照抄 dsh-amd-model-load 的 mountRpcChannel / serve / reply）
/** 端点路径段的合法字符集，与官方 ENDPOINT_SEGMENT_PATTERN 一致。 */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** 唯一接受的 content-type，与官方信封契约一致。 */
const JSON_MIME = 'application/json'

/** 请求体超限的标记错误，由 serve 决定如何回写与断开。 */
export class PayloadTooLargeError extends Error {}

/**
 * 挂载 RPC 通道。webServer 或 connection 缺席时不挂载，插件其余功能不受影响。
 *
 * @param ctx - 插件上下文。
 * @param channel - 绝对通道前缀。
 * @param handler - `(endpoint, payload) => Promise<result>`，result 已是 `{ok,...}` 信封。
 * @param maxBodyBytes - 请求体上限。
 */
export function mountRpcChannel(ctx, channel, handler, maxBodyBytes) {
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
export async function serve(connection, channel, handler, maxBodyBytes, req, res) {
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
export function missing(res) {
  res.writeHead(404)
  res.end('not found')
}

/** 回写一个 server-response 信封。 */
export function reply(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** 先回 413 再销毁连接：顺序反了 socket 已断，413 永远发不出去。 */
export function tooLarge(req, res) {
  res.writeHead(413, { connection: 'close' })
  res.end('payload too large')
  req.destroy()
}

/** content-type 必须声明为 application/json，charset 等参数可忽略。 */
export function isJsonContentType(req) {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return false
  const mime = header.split(';', 1)[0]
  return mime !== undefined && mime.trim().toLowerCase() === JSON_MIME
}

/** 读取并限长请求体，超限抛 PayloadTooLargeError，由调用方回写 413。 */
export async function readBody(req, maxBodyBytes) {
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
