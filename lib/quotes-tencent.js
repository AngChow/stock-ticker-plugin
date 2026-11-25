/**
 * 腾讯免费行情接口（qt.gtimg.cn）：
 * - GBK 编码、毫秒级返回、支持批量。
 * - 字段布局（~ 分隔）经实测：
 *   [1] 名称 [2] 数字代码 [3] 现价 [4] 昨收 [5] 今开
 *   [30] 时间 yyyymmddhhmmss [31] 涨跌额 [32] 涨跌幅% [33] 最高 [34] 最低
 */

const TENCENT_URL = 'https://qt.gtimg.cn/q='

function decodeGbk(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return Buffer.from(buffer).toString('latin1')
  }
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function formatTime(raw) {
  const m = String(raw).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`
}

/**
 * 网络层失败的中文归因表：undici 只给一句 "fetch failed"，
 * 真正的原因在 error.cause.code 里。带上 code 才能在悬浮条上一眼看懂。
 */
const CAUSE_HINTS = {
  ENOTFOUND: 'DNS 解析失败',
  EAI_AGAIN: 'DNS 暂不可用',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时',
  EPIPE: '连接被中断',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_SOCKET: '连接中断',
  UND_ERR_CLOSED: '连接被关闭',
  CERT_HAS_EXPIRED: '证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '证书不受信（自签）',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链不受信',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配',
}

/** 把 fetch 的异常转成一句人能读懂的错误文案（纯函数，便于单测）。 */
export function describeFetchError(error) {
  if (!error) return '行情请求失败：未知错误'
  if (error.name === 'TimeoutError') return '行情请求超时'
  const code = error?.cause?.code ?? error?.code ?? null
  const hint = code ? CAUSE_HINTS[code] : null
  if (hint) return `行情请求失败：${hint}（${code}）`
  const message = error?.message ?? String(error)
  return code ? `行情请求失败：${message}（${code}）` : `行情请求失败：${message}`
}

/**
 * 批量拉取行情。
 * @returns {{ ok: true, quotes: Array, invalid: string[] } | { ok: false, error: string }}
 */
export async function fetchTencentQuotes(codes, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  if (!Array.isArray(codes) || codes.length === 0) {
    return { ok: true, quotes: [], invalid: [] }
  }
  let res
  try {
    res = await fetchImpl(TENCENT_URL + codes.join(','), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { referer: 'https://gu.qq.com/' },
    })
  } catch (error) {
    return { ok: false, error: describeFetchError(error) }
  }
  if (!res.ok) {
    return { ok: false, error: `行情接口 HTTP ${res.status}` }
  }
  let text
  try {
    text = decodeGbk(await res.arrayBuffer())
  } catch (error) {
    return { ok: false, error: `行情响应解码失败：${error?.message ?? error}` }
  }

  const quotes = []
  const invalid = []
  for (const match of text.matchAll(/v_([A-Za-z]{2}[A-Za-z0-9]+)="([^"]*)"/g)) {
    const requested = match[1].toLowerCase()
    const fields = match[2].split('~')
    if (fields.length < 35) {
      invalid.push(requested)
      continue
    }
    const price = toNumber(fields[3])
    if (price === null) {
      invalid.push(requested)
      continue
    }
    quotes.push({
      code: requested,
      name: fields[1],
      price,
      prevClose: toNumber(fields[4]),
      open: toNumber(fields[5]),
      time: formatTime(fields[30]),
      change: toNumber(fields[31]),
      changePct: toNumber(fields[32]),
      high: toNumber(fields[33]),
      low: toNumber(fields[34]),
      source: 'tencent',
    })
  }
  const found = new Set(quotes.map(quote => quote.code))
  for (const code of codes) {
    if (!found.has(code.toLowerCase())) invalid.push(code)
  }
  return { ok: true, quotes, invalid }
}

/**
 * 节假日自检：行情时间戳是否「新」——至少一条的时间日期等于上海时区今天。
 * 返回 true=当天确实在交易；false=全部滞后于今天（节假日/临时休市）；
 * null=没有任何可解析时间（如空列表/字段缺失），调用端应保持原判定。
 * 比维护节假日表更准：临时休市、突发停市都自动覆盖，且无需每年更新数据。
 */
export function quotesFresh(quotes, todayYmd) {
  let seen = false
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    const time = typeof quote?.time === 'string' ? quote.time : ''
    if (!/^\d{4}-\d{2}-\d{2} /.test(time)) continue
    seen = true
    if (time.slice(0, 10) === todayYmd) return true
  }
  return seen ? false : null
}
