/**
 * 涨乐财富通 queryIndicator 接口（与 query-indicator skill 同源直调）：
 * POST https://ai.zhangle.com/edge/entry/gate/api/finAnalysis/queryIndicator
 * headers: apiKey + skillCode；body: { query }
 * 返回 Markdown 文本（表格或列表），本模块负责调用与宽容解析。
 *
 * apiKey 读自 ~/.htsc-skills/config（与金融类 skill 共用），绝不写日志、
 * 不进入任何返回值。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVICE_URL = 'https://ai.zhangle.com'
const BASE_PATH = '/edge/entry/gate'
const SKILL_CODE = 'mx_1779108020995' // queryIndicator 网关路由码

let apiKeyCache

/** 读取 HT_APIKEY；读不到返回 null 并由调用方降级。 */
export function htApiKey(configPath = join(homedir(), '.htsc-skills', 'config')) {
  if (apiKeyCache !== undefined) return apiKeyCache
  try {
    const text = readFileSync(configPath, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const [key, ...rest] = trimmed.split('=')
      if (key.trim() === 'HT_APIKEY') {
        apiKeyCache = rest.join('=').trim()
        break
      }
    }
  } catch {
    apiKeyCache = null
  }
  if (!apiKeyCache) apiKeyCache = null
  return apiKeyCache
}

/** 测试用：清空 key 缓存。 */
export function resetHtApiKeyCache() {
  apiKeyCache = undefined
}

/**
 * 调用 queryIndicator，返回 answer 文本。
 * 抛错时 message 面向用户（中文、不含密钥）。
 */
export async function zhangleQueryIndicator(query, { timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = htApiKey()
  if (!apiKey) {
    throw new Error('未找到 HT_APIKEY（~/.htsc-skills/config），涨乐兜底不可用')
  }
  let res
  try {
    res = await fetchImpl(`${SERVICE_URL}${BASE_PATH}/api/finAnalysis/queryIndicator`, {
      method: 'POST',
      headers: {
        apiKey,
        skillCode: SKILL_CODE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '涨乐接口超时' : `涨乐接口连接失败：${error?.message ?? error}`
    throw new Error(reason)
  }
  if (!res.ok) {
    throw new Error(`涨乐接口 HTTP ${res.status}`)
  }
  let payload
  try {
    payload = await res.json()
  } catch {
    throw new Error('涨乐接口返回内容无法解析')
  }
  if (payload?.code !== 0) {
    throw new Error(`涨乐接口错误：${payload?.message ?? '未知错误'}`)
  }
  const answer = payload?.data?.answer
  if (typeof answer !== 'string' || answer.length === 0) {
    throw new Error('涨乐接口未返回有效内容')
  }
  return answer
}

/**
 * 从 answer 中解析指定 6 位数字代码的行情。
 * 兼容两种实测格式：
 *   表格：| 华泰证券(601688) | 17.90元 | 0.62% |
 *   列表：- **华泰证券（601688）**：最新价17.90元，涨跌幅+0.62%
 * @returns {{ name: string, digits: string, price: number|null, changePct: number|null } | null}
 */
export function parseZhangleQuote(answer, digits) {
  if (typeof answer !== 'string' || !digits) return null
  const lines = answer.split('\n')
  for (const line of lines) {
    if (!line.includes(digits)) continue
    const nameMatch = line.match(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9*]{0,19})\s*[（(]\s*(\d{5,6})\s*[）)]/)
    if (!nameMatch) continue
    const name = nameMatch[1]
    const priceMatch = line.match(/(\d+(?:\.\d+)?)\s*元/) ?? line.match(/\|\s*(\d+(?:\.\d+)?)/)
    const pctMatch = line.match(/([+\-]?\d+(?:\.\d+)?)\s*%/)
    return {
      name,
      digits: nameMatch[2],
      price: priceMatch ? Number(priceMatch[1]) : null,
      changePct: pctMatch ? Number(pctMatch[1]) : null,
    }
  }
  return null
}

/**
 * 校验一个标的并解析名称（涨乐优先，语义即"配置时校验"）。
 * @returns {{ ok: true, name: string, source: 'zhangle', price?: number, changePct?: number }
 *          | { ok: false, reason: string }}
 */
export async function zhangleResolve(digits, { timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  try {
    const answer = await zhangleQueryIndicator(`${digits} 的最新价和涨跌幅`, { timeoutMs, fetchImpl })
    const quote = parseZhangleQuote(answer, digits)
    if (quote) {
      return {
        ok: true,
        name: quote.name,
        source: 'zhangle',
        ...(quote.price !== null ? { price: quote.price } : {}),
        ...(quote.changePct !== null ? { changePct: quote.changePct } : {}),
      }
    }
    return { ok: false, reason: `涨乐未识别代码 ${digits}` }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
}
