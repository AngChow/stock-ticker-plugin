/**
 * 股票代码规范化：把用户输入宽容地归一成腾讯行情的代码形式。
 * 支持：
 *   600519 / sh600519 / SH.600519 / 600519.SH   → sh600519 | sz600519 | bj920xxx
 *   00700 / hk00700 / HK.00700                  → hk00700
 *   aapl / AAPL                                  → usAAPL
 */

export function normalizeSymbol(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s`'"]/g, '')
  if (!s) return { ok: false, reason: '代码为空' }

  let m
  // sh600519 / sz000001 / bj920009（允许 SH.600519、sh-600519）
  if ((m = s.match(/^(sh|sz|bj)[.\-]?(\d{6})$/))) return { ok: true, code: m[1] + m[2] }
  // 600519.SH / 000001.sz
  if ((m = s.match(/^(\d{6})\.(sh|sz|bj)$/))) return { ok: true, code: m[2] + m[1] }
  // 港股：hk00700 / hk.00700 / hk700（1-5 位，左侧补零到 5 位）
  if ((m = s.match(/^hk[.\-]?(\d{1,5})$/))) return { ok: true, code: 'hk' + m[1].padStart(5, '0') }
  if ((m = s.match(/^(\d{5})$/))) return { ok: true, code: 'hk' + m[1] }
  // A 股 6 位数字按前缀推断市场
  if ((m = s.match(/^(\d{6})$/))) {
    const code = m[1]
    if (/^(60|68)/.test(code)) return { ok: true, code: 'sh' + code }
    if (/^(00|30)/.test(code)) return { ok: true, code: 'sz' + code }
    if (/^(43|83|87|92)/.test(code)) return { ok: true, code: 'bj' + code }
    return { ok: false, reason: `无法识别 A 股市场前缀：${code}` }
  }
  // 美股：1-5 个字母
  if ((m = s.match(/^([a-z]{1,5})$/))) return { ok: true, code: 'us' + m[1].toUpperCase() }
  return { ok: false, reason: `无法识别的代码：${String(raw)}` }
}

/** 从规范化代码还原展示用的「市场 + 裸代码」。 */
export function displayCode(code) {
  const m = String(code).match(/^(sh|sz|bj|hk|us)(.+)$/)
  if (!m) return { market: '', digits: String(code) }
  const marketNames = { sh: '沪', sz: '深', bj: '北', hk: '港', us: '美' }
  return { market: marketNames[m[1]] ?? m[1].toUpperCase(), digits: m[2] }
}
