/**
 * stock-ticker 引擎单测：node --test tests/
 * 网络样本来自 2026-11-05 实测录制，不发真实请求。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { marketPhase, shanghaiNow, isLivePhase, effectivePhase, PHASE_LABELS } from '../lib/market-hours.js'
import { normalizeSymbol, displayCode } from '../lib/normalize.js'
import { fetchTencentQuotes, quotesFresh } from '../lib/quotes-tencent.js'
import { parseZhangleQuote, htApiKey, resetHtApiKeyCache } from '../lib/zhangle.js'
import { normalizeSettings, nonLiveFetchPlan } from '../index.js'

function at(ymd, hhmm, offsetDays = 0) {
  // 在上海时区构造一个确定时刻（本地为 Asia/Shanghai 环境下直接用本地时间等价）
  return new Date(`${ymd}T${hhmm}:00+08:00`)
}

test('marketPhase: 各阶段划分（周四交易日）', () => {
  assert.equal(marketPhase(at('2026-11-05', '09:00')), 'pre')
  assert.equal(marketPhase(at('2026-11-05', '09:30')), 'open')
  assert.equal(marketPhase(at('2026-11-05', '10:00')), 'open')
  assert.equal(marketPhase(at('2026-11-05', '11:31')), 'break')
  assert.equal(marketPhase(at('2026-11-05', '12:59')), 'break')
  assert.equal(marketPhase(at('2026-11-05', '13:00')), 'open')
  assert.equal(marketPhase(at('2026-11-05', '14:59')), 'open')
  assert.equal(marketPhase(at('2026-11-05', '15:00')), 'closed')
  assert.equal(marketPhase(at('2026-11-05', '23:59')), 'closed')
})

test('marketPhase: 周末休市', () => {
  assert.equal(marketPhase(at('2026-11-07', '10:00')), 'closed') // 周六
  assert.equal(marketPhase(at('2026-11-08', '10:00')), 'closed') // 周日
})

test('shanghaiNow: 时区换算正确', () => {
  const now = shanghaiNow(at('2026-11-05', '09:30'))
  assert.equal(now.ymd, '2026-11-05')
  assert.equal(now.minutes, 9 * 60 + 30)
  assert.equal(now.weekday, 4) // 周四
})

test('isLivePhase', () => {
  assert.equal(isLivePhase('open'), true)
  assert.equal(isLivePhase('break'), false)
  assert.equal(isLivePhase('closed'), false)
})

test('normalizeSymbol: 各类输入', () => {
  const cases = [
    ['600519', 'sh600519'],
    ['sh600519', 'sh600519'],
    ['SH.600519', 'sh600519'],
    ['600519.SH', 'sh600519'],
    ['300750', 'sz300750'],
    ['000001', 'sz000001'],
    ['688981', 'sh688981'],
    ['920009', 'bj920009'],
    ['00700', 'hk00700'],
    ['hk700', 'hk00700'],
    ['HK.00700', 'hk00700'],
    ['aapl', 'usAAPL'],
    ['AAPL', 'usAAPL'],
  ]
  for (const [input, expected] of cases) {
    const result = normalizeSymbol(input)
    assert.equal(result.ok, true, `input ${input}`)
    assert.equal(result.code, expected, `input ${input}`)
  }
})

test('normalizeSymbol: 拒绝非法输入', () => {
  for (const input of ['', '12345678', '12a456', '6000000', '中文']) {
    assert.equal(normalizeSymbol(input).ok, false, `input ${input}`)
  }
})

test('displayCode', () => {
  assert.deepEqual(displayCode('sh600519'), { market: '沪', digits: '600519' })
  assert.deepEqual(displayCode('hk00700'), { market: '港', digits: '00700' })
  assert.deepEqual(displayCode('usAAPL'), { market: '美', digits: 'AAPL' })
})

// 2026-11-05 实测字段布局的 GBK 原始响应（base64，自包含）。
const TENCENT_SAMPLE_GBK_B64 = 'dl9zaDYwMTY4OD0iMX67qsyp1qTIr342MDE2ODh+MTcuOTB+MTcuNzl+MTcuNjh+NDE5MjQxfjIxNDE0Nn4yMDUwOTV+MTcuODd+MjB+MTcuODZ+MjQyfjE3Ljg1fjIyNTN+MTcuODR+MTE4NH4xNy44M343NTd+MTcuOTB+MzAzNH4xNy45MX4xODIxfjE3LjkyfjIwOTl+MTcuOTN+MzQxNX4xNy45NH4yMjM0fn4yMDI2MTEwNTE2MTQ1OH4wLjExfjAuNjJ+MTcuOTZ+MTcuNjh+MTcuOTAvNDE5MjQxLzc0ODI1ODY5Nn40MTkyNDF+NzQ4MjZ+MC41N344LjY0fn4xNy45Nn4xNy42OH4xLjU3fjEzMDcuOTF+MTYxNS44MX4wLjg5fjE5LjU3fjE2LjAxfjAuNTd+LTgxNDd+MTcuODV+OC4wNn45Ljg2fn5+MS4xMX43NDgyNS44Njk2fjE5LjUxMTB+MTA5fiAgIEF+R1AtQX4tMjIuMjF+NC43NH4zLjI0fjguNjB+MS41MH4yNS4xN34xNi40OX41Ljc5fjIuNzZ+LTYuNzJ+NzMwNjc1ODEwNn45MDI2ODYzNzg2fi00Ny43Nn4tMTUuNTN+NzMwNjc1ODEwNn5+fi0xMi44MX4wLjIyfn5DTll+MH5fX19EX19GX19OfjE3Ljk5fi00NDMxfiI7CnZfc2g2MDA1MTk9IjF+ufPW3cOpzKh+NjAwNTE5fjE0NTIuMDB+MTQ0Ni40NH4xNDQ2LjcwfjQ2NzEyfjI1MDE0fjIxNjk4fjE0NTEuNTB+MX4xNDUxLjAwfjl+MTQ1MC41N34yfjE0NTAuNTB+MX4xNDUwLjEzfjF+MTQ1Mi4wMH4xNX4xNDUyLjAzfjF+MTQ1Mi4zOH4xfjE0NTIuNDl+Mn4xNDUyLjY2fjN+fjIwMjYxMTA1MTYxNDQxfjUuNTZ+MC4zOH4xNDY2LjAwfjE0MzAuMDB+MTQ1Mi4wMC80NjcxMi82NzUyOTcwOTE1fjQ2NzEyfjY3NTI5N34wLjM3fjIyLjA5fn4xNDY2LjAwfjE0MzAuMDB+Mi40OX4xODE1MS4xOH4xODE1MS4xOH42LjY5fjE1OTEuMDh+MTMwMS44MH4wLjcyfi04fjE0NDUuNjV+MjEuMTJ+MjIuMDV+fn4tMC4wMn42NzUyOTcuMDkxNX4xMTYuMTYwMH44fiAgIEF+R1AtQX43LjYyfjcuMjR+My41OH4zMC4yOX4yNi43NH4xNTM5Ljk4fjExNTEuMDF+MTAuMTN+MTUuNjJ+MTEuMTR+MTI1MDA4MTYwMX4xMjUwMDgxNjAxfi0yMi4yMn4wLjM1fjEyNTAwODE2MDF+fn42LjEzfjAuMjF+fkNOWX4wfl9fX0RfX0ZfX05+MTQ1Mi43NH4tOX4iOwp2X3N6MzAwNzUwPSI1MX7E/rXCyrG0+n4zMDA3NTB+MjY0LjA2fjI1Mi44OH4yNTcuNDB+NjkzNTEyfjMzNTQ4MX4zNTgwMzF+MjY0LjA2fjM4fjI2NC4wNX4yNn4yNjQuMDR+OX4yNjQuMDN+MTF+MjY0LjAyfjE5fjI2NC4xMH4xfjI2NC4xMX40MX4yNjQuMTd+Mn4yNjQuMjJ+Mn4yNjQuMjR+NX5+MjAyNjExMDUxNjE0NDV+MTEuMTh+NC40Mn4yNzIuMTl+MjU1LjkzfjI2NC4wNi82OTM1MTIvMTg0MDIzMzEzMzd+NjkzNTEyfjE4NDAyMzN+MS42M34xMy45M35+MjcyLjE5fjI1NS45M342LjQzfjExMjUwLjU5fjEyMjE4LjcyfjMuMTZ+MzAzLjQ2fjIwMi4zMH4xLjM3fjUyfjI2NS4zNX4xNC4yMH4xNi45Mn5+fjAuOTJ+MTg0MDIzMy4xMzM3fjI1OC43Nzg4fjk4fiBBIEF+R1AtQS1DWUJ+LTI2LjQ0fjE1LjI3fjMuMTF+MjIuNjd+Ny45NH40NjcuMzV+MjE2LjUxfjE5Ljgwfi03Ljkxfi0zNC42MX40MjYwNjE3MDgzfjQ2MjcyNDk2ODZ+MzMuNzd+LTIyLjI0fjQyNjA2MTcwODN+fn4tMzAuNTh+LTAuMjF+fkNOWX4wfn4yNjQuMDB+NzcxfiI7Cg=='

function fakeFetchTencent() {
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(Buffer.from(TENCENT_SAMPLE_GBK_B64, 'base64')),
  })
}

test('fetchTencentQuotes: 批量解析（GBK 由调用端解码，此处测字段布局）', async () => {
  const result = await fetchTencentQuotes(['sh601688', 'sh600519', 'sz300750', 'sh999999'], { fetchImpl: fakeFetchTencent() })
  assert.equal(result.ok, true)
  assert.equal(result.quotes.length, 3)
  assert.equal(result.invalid.includes('sh999999'), true)

  const htt = result.quotes.find(quote => quote.code === 'sh601688')
  assert.equal(htt.name, '华泰证券')
  assert.equal(htt.price, 17.9)
  assert.equal(htt.prevClose, 17.79)
  assert.equal(htt.change, 0.11)
  assert.equal(htt.changePct, 0.62)
  assert.equal(htt.high, 17.96)
  assert.equal(htt.low, 17.68)
  assert.equal(htt.time, '2026-11-05 16:14:58')

  const maotai = result.quotes.find(quote => quote.code === 'sh600519')
  assert.equal(maotai.name, '贵州茅台')
  assert.equal(maotai.price, 1452.0)
  assert.equal(maotai.changePct, 0.38)

  const catl = result.quotes.find(quote => quote.code === 'sz300750')
  assert.equal(catl.name, '宁德时代')
  assert.equal(catl.changePct, 4.42)
})

test('fetchTencentQuotes: 网络失败返回错误对象', async () => {
  const result = await fetchTencentQuotes(['sh600519'], {
    fetchImpl: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
})

test('fetchTencentQuotes: 空列表直接返回', async () => {
  const result = await fetchTencentQuotes([], { fetchImpl: fakeFetchTencent() })
  assert.equal(result.ok, true)
  assert.deepEqual(result.quotes, [])
})

const ZHANGLE_TABLE =
  '2026年11月05日A股已收盘，两只标的的相关数据如下：\n' +
  '| 证券名称 | 最新价 | 涨跌幅 |\n| --- | --- | --- |\n' +
  '| 华泰证券(601688) | 17.90元 | 0.62% |\n| 贵州茅台(600519) | 1452.00元 | 0.38% |\n' +
  '两只个股今日均小幅收涨。'

const ZHANGLE_LIST =
  '截至2026年11月5日收盘，标的今日行情如下：\n\n' +
  '- **华泰证券（601688）**：最新价17.90元，涨跌幅+0.62%。今日开盘价17.68元即为全天最低价。\n' +
  '- **贵州茅台（600519）**：最新价1452.00元，涨跌幅+0.38%。走势相对平稳。\n\n' +
  '整体来看今日收涨。'

test('parseZhangleQuote: 表格格式', () => {
  const quote = parseZhangleQuote(ZHANGLE_TABLE, '601688')
  assert.ok(quote)
  assert.equal(quote.name, '华泰证券')
  assert.equal(quote.price, 17.9)
  assert.equal(quote.changePct, 0.62)
})

test('parseZhangleQuote: 列表格式（含加号涨跌幅）', () => {
  const quote = parseZhangleQuote(ZHANGLE_LIST, '600519')
  assert.ok(quote)
  assert.equal(quote.name, '贵州茅台')
  assert.equal(quote.price, 1452.0)
  assert.equal(quote.changePct, 0.38)
})

test('parseZhangleQuote: 无匹配返回 null', () => {
  assert.equal(parseZhangleQuote(ZHANGLE_TABLE, '999999'), null)
  assert.equal(parseZhangleQuote('无内容', '601688'), null)
})

test('htApiKey: 从配置文件读取且不含等号后内容丢失', async () => {
  resetHtApiKeyCache()
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-test-'))
  const file = path.join(dir, 'config')
  fs.writeFileSync(file, '# comment\nOTHER=1\nHT_APIKEY=abc=def\n')
  assert.equal(htApiKey(file), 'abc=def')
  resetHtApiKeyCache()
})

test('normalizeSettings: 宽容化与去重', () => {
  const settings = normalizeSettings({
    symbols: ['600519', 'sh600519', 'bogus!!', '300750'],
    pollSeconds: 0,
    enabled: false,
  })
  assert.deepEqual(settings.symbols, ['sh600519', 'sz300750'])
  assert.equal(settings.pollSeconds, 1)
  assert.equal(settings.enabled, false)

  const defaults = normalizeSettings(undefined)
  assert.deepEqual(defaults.symbols, [])
  assert.equal(defaults.pollSeconds, 2)
  assert.equal(defaults.enabled, true)

  const clamped = normalizeSettings({ pollSeconds: 999 })
  assert.equal(clamped.pollSeconds, 120)
})

test('nonLiveFetchPlan: 收盘后必须补一次收盘复核', () => {
  const today = '2026-11-23'
  const base = { phase: 'closed', today, lastLiveYmd: today, closeSettledYmd: null, fetchedForCurrentList: true }
  // 收盘后补一次。盘中最后一帧是集合竞价期间的盘口价，不是 15:00 撮合出的收盘价
  // （实测 002714 停在 45.33、收盘 45.38；000100 停在 4.91、收盘 4.89）。
  assert.equal(nonLiveFetchPlan(base), 'close-settle')
  // 已复核 → 不再请求，避免收盘后无限轮询。
  assert.equal(nonLiveFetchPlan({ ...base, closeSettledYmd: today }), null)
  // 午休不能核销：否则 15:00 那次真正的收盘复核会被吃掉。
  assert.equal(nonLiveFetchPlan({ ...base, phase: 'break', closeSettledYmd: null }), null)
  assert.equal(nonLiveFetchPlan({ ...base, phase: 'pre' }), null)
})

test('nonLiveFetchPlan: 首次启动与新列表取一次快照', () => {
  const today = '2026-11-23'
  assert.equal(
    nonLiveFetchPlan({ phase: 'closed', today, lastLiveYmd: null, closeSettledYmd: null, fetchedForCurrentList: false }),
    'snapshot',
  )
  // 隔夜：昨天的盘中与复核都不算今天，盘前不重复请求。
  assert.equal(
    nonLiveFetchPlan({ phase: 'pre', today, lastLiveYmd: '2026-11-22', closeSettledYmd: '2026-11-22', fetchedForCurrentList: true }),
    null,
  )
  // 周末收盘后启动：lastLiveYmd 是上一交易日 → 只走快照分支一次。
  assert.equal(
    nonLiveFetchPlan({ phase: 'closed', today: '2026-11-21', lastLiveYmd: '2026-11-20', closeSettledYmd: '2026-11-20', fetchedForCurrentList: false }),
    'snapshot',
  )
})

test('quotesFresh: 行情时间戳是否为上海时区今天', () => {
  const live = [{ time: '2026-11-05 09:31:02' }]
  assert.equal(quotesFresh(live, '2026-11-05'), true)
  assert.equal(quotesFresh(live, '2026-11-07'), false) // 时间戳停在上一交易日 → 节假日休市
})

test('quotesFresh: 任一市场当天有数据即算新', () => {
  const mixed = [{ time: '2026-11-05 16:14:58' }, { time: '2026-11-06 04:00:00' }]
  assert.equal(quotesFresh(mixed, '2026-11-06'), true)
  assert.equal(quotesFresh(mixed, '2026-11-08'), false)
})

test('quotesFresh: 无可解析时间返回 null（保持原判定）', () => {
  assert.equal(quotesFresh([], '2026-11-05'), null)
  assert.equal(quotesFresh(undefined, '2026-11-05'), null)
  assert.equal(quotesFresh([{ time: null }, { time: 'bad' }], '2026-11-05'), null)
})

test('effectivePhase: 墙钟开盘 + 行情滞后 → holiday 展示态', () => {
  assert.equal(effectivePhase('open', true), 'holiday')
  assert.equal(effectivePhase('open', false), 'open')
  assert.equal(effectivePhase('closed', true), 'closed')
  assert.equal(effectivePhase('break', true), 'break')
  assert.equal(effectivePhase('pre', true), 'pre')
  assert.equal(isLivePhase('holiday'), false)
  assert.equal(PHASE_LABELS.holiday, '休市（节假日）')
})
