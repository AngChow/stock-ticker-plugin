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
    const reason = error?.name === 'TimeoutError' ? '行情请求超时' : `行情请求失败：${error?.message ?? error}`
    return { ok: false, error: reason }
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
