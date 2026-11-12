/**
 * stock-ticker — 自选行情悬浮条（Client 半区，浏览器）
 *
 * - shell.overlay：右上角悬浮行情条，全局可见，可折叠；
 * - settings.plugins.tab：「自选行情」设置页（管理股票、刷新间隔、开关）；
 * - 数据来自 Host 半区 RPC（同一浏览器认证栅栏），Client 每秒拉取快照，
 *   价格红涨绿跌（A股配色），页脚显示「更新于 Ns 前」每秒跳动。
 */

window.__ModuleLoader__.load({
  id: 'stock-ticker',
  factory(require) {
    // 诊断：client 半区加载失败时，renderer 只报 "failed"，原因不会外露。
    // console.error 会被宿主崩溃报告收录，用来定位究竟哪一步抛错。
    console.error('[stock-ticker] factory enter')
    const React = require('react')
    const h = React.createElement

    const NS = 'stock-ticker'
    const CHANNEL = '/api/stock-ticker'

    const zh = {
      'meta.title': '自选行情',
      'meta.description': '在 DSH 界面右上角实时显示自选股价格（红涨绿跌），盘中按秒刷新，支持在设置中管理股票列表。',
      'overlay.title': '自选行情',
      'overlay.collapse': '收起行情条',
      'overlay.expand': '展开行情条',
      'overlay.updatedAgo': '更新于 {n}s 前',
      'overlay.updating': '行情拉取中…',
      'overlay.never': '等待首次行情…',
      'overlay.manageHint': '在 设置 → 插件 → 自选行情 中管理股票',
      'overlay.disabled': '行情显示已关闭',
      'overlay.offline': '行情服务未连接',
      'phase.open': '盘中',
      'phase.break': '午间休市',
      'phase.pre': '盘前',
      'phase.closed': '已收盘',
      'phase.holiday': '休市（节假日）',
      'settings.title': '自选股列表',
      'settings.inputPlaceholder': '输入代码回车添加：600519 / sh600519 / 00700 / AAPL',
      'settings.add': '添加',
      'settings.resolving': '校验中…',
      'settings.remove': '移除',
      'settings.empty': '暂无自选股，先添加一只吧',
      'settings.intervalLabel': '盘中刷新间隔',
      'settings.seconds': '秒',
      'settings.enabledLabel': '启用行情悬浮条',
      'settings.saved': '已保存并热生效',
      'settings.saveFailed': '保存失败',
      'settings.rpcMissing': '宿主未提供行情服务（插件可能未激活）',
      'settings.source.zhangle': '涨乐',
      'settings.source.tencent': '腾讯',
    }
    const en = {
      'meta.title': 'Stock Ticker',
      'meta.description': 'Shows your watchlist prices live (red up, green down) at the top-right of DSH, refreshed per second during trading hours.',
      'overlay.title': 'Stock Ticker',
      'overlay.collapse': 'Collapse ticker',
      'overlay.expand': 'Expand ticker',
      'overlay.updatedAgo': 'updated {n}s ago',
      'overlay.updating': 'fetching quotes…',
      'overlay.never': 'waiting for first quote…',
      'overlay.manageHint': 'Manage stocks in Settings → Plugins → Stock Ticker',
      'overlay.disabled': 'Ticker disabled',
      'overlay.offline': 'quote service unavailable',
      'phase.open': 'open',
      'phase.break': 'lunch break',
      'phase.pre': 'pre-market',
      'phase.closed': 'closed',
      'phase.holiday': 'closed (holiday)',
      'settings.title': 'Watchlist',
      'settings.inputPlaceholder': 'Add by code: 600519 / sh600519 / 00700 / AAPL',
      'settings.add': 'Add',
      'settings.resolving': 'validating…',
      'settings.remove': 'remove',
      'settings.empty': 'No stocks yet — add one above',
      'settings.intervalLabel': 'Live refresh interval',
      'settings.seconds': 's',
      'settings.enabledLabel': 'Enable ticker overlay',
      'settings.saved': 'Saved & applied',
      'settings.saveFailed': 'Save failed',
      'settings.rpcMissing': 'Quote service unavailable (plugin inactive?)',
      'settings.source.zhangle': 'ZL',
      'settings.source.tencent': 'TX',
    }

    // ---- RPC（与 dsh-client-connection 的信封一致） ----
    async function rpc(endpoint, payload) {
      const res = await fetch(CHANNEL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: endpoint, payload: payload ?? null }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // Host 的精确 Fetch 路由直接返回 { ok, value }；
      // dsh 原生 RPC 通道则包一层 { result: { ok, value } }。两种都认。
      const result = data?.result ?? data
      if (!result) throw new Error('RPC envelope missing result')
      if (!result.ok) throw new Error(result.error?.message ?? 'RPC failed')
      return result.value
    }

    // ---- 红涨绿跌（A股配色，明暗两套） ----
    const STYLE = `
.stk-up { color: #c53030; }
.stk-down { color: #047857; }
.stk-flat { color: var(--dsw-alias-label-secondary); }
body[data-ds-dark-theme] .stk-up { color: #f87171; }
body[data-ds-dark-theme] .stk-down { color: #34d399; }
.stk-overlay { position: fixed; top: 8px; right: 176px; z-index: 90; font-size: 12px;
  font-family: inherit; user-select: none; }
.stk-pill { display: flex; align-items: center; gap: 7px; box-sizing: border-box;
  height: 32px; padding: 0 12px; border-radius: 999px;
  background: rgba(255,255,255,.82);
  -webkit-backdrop-filter: blur(14px) saturate(180%);
  backdrop-filter: blur(14px) saturate(180%);
  border: 1px solid rgba(255,255,255,.55);
  box-shadow: 0 1px 6px rgba(0,0,0,.10); cursor: pointer; line-height: 1.2; }
.stk-pill:hover { border-color: var(--dsw-alias-border-l2); }
body[data-ds-dark-theme] .stk-pill {
  background: rgba(38,38,42,.78);
  border-color: rgba(255,255,255,.12);
  box-shadow: 0 1px 8px rgba(0,0,0,.38);
}
body[data-ds-dark-theme] .stk-pill:hover { border-color: rgba(255,255,255,.22); }
.stk-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-state-idle-primary); }
.stk-dot.live { background: var(--dsw-alias-state-success-primary); animation: stk-pulse 2s ease-in-out infinite; }
@keyframes stk-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
.stk-panel { width: 330px; border-radius: 12px; overflow: hidden;
  background: rgba(255,255,255,.86);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
  backdrop-filter: blur(18px) saturate(180%);
  border: 1px solid rgba(255,255,255,.6);
  box-shadow: 0 12px 36px rgba(0,0,0,.16); }
body[data-ds-dark-theme] .stk-panel {
  background: rgba(30,30,34,.86);
  border-color: rgba(255,255,255,.10);
  box-shadow: 0 14px 40px rgba(0,0,0,.5);
}
body[data-ds-dark-theme] .stk-row:hover { background: rgba(255,255,255,.055); }
body[data-ds-dark-theme] .stk-head,
body[data-ds-dark-theme] .stk-foot { border-color: rgba(255,255,255,.08); }
.stk-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.stk-head-title { font-weight: 600; color: var(--dsw-alias-label-primary); font-size: 12.5px; }
.stk-phase { padding: 1px 8px; border-radius: 999px; font-size: 11px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.stk-close { margin-left: auto; border: none; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 14px; padding: 2px 6px; border-radius: 6px; }
.stk-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.stk-rows { max-height: 300px; overflow-y: auto; }
.stk-row { display: flex; align-items: baseline; gap: 8px; padding: 7px 12px; }
.stk-row:hover { background: var(--dsw-alias-bg-layer-1); }
.stk-name { color: var(--dsw-alias-label-primary); font-size: 12.5px; max-width: 110px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stk-code { color: var(--dsw-alias-label-secondary); font-size: 10.5px; }
.stk-price { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12.5px; }
.stk-pct { min-width: 56px; text-align: right; font-variant-numeric: tabular-nums; font-size: 11.5px; }
.stk-foot { padding: 6px 12px 8px; border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); font-size: 10.5px; line-height: 1.5; }
.stk-err { color: var(--dsw-alias-state-warn-primary); }
.stk-hint { color: var(--dsw-alias-label-secondary); font-size: 10.5px; padding: 6px 12px 9px; }
.stk-page { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.stk-addrow { display: flex; gap: 8px; }
.stk-input { flex: 1; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12.5px; }
.stk-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.stk-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12.5px; }
.stk-btn:hover { border-color: var(--dsw-alias-border-l2); }
.stk-btn[disabled] { opacity: .55; cursor: default; }
.stk-list { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.stk-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.stk-item + .stk-item { border-top: 1px solid var(--dsw-alias-border-l1); }
.stk-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.stk-del { margin-left: auto; border: none; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 2px 8px; border-radius: 6px; }
.stk-del:hover { color: var(--dsw-alias-state-error-primary); }
.stk-setting-line { display: flex; align-items: center; gap: 10px; }
.stk-switch { position: relative; width: 34px; height: 20px; border-radius: 999px; border: none; cursor: pointer;
  background: var(--dsw-alias-border-l2); transition: background .15s; padding: 0; }
.stk-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.stk-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 999px; background: var(--dsw-alias-bg-base); transition: left .15s; }
.stk-switch[aria-checked="true"]::after { left: 16px; }
.stk-note { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.stk-note-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
`

    function colorClass(pct) {
      if (pct === null || pct === undefined || Number.isNaN(pct)) return 'stk-flat'
      if (pct > 0) return 'stk-up'
      if (pct < 0) return 'stk-down'
      return 'stk-flat'
    }

    function formatPct(pct) {
      if (pct === null || pct === undefined || Number.isNaN(pct)) return '—'
      const sign = pct > 0 ? '+' : ''
      return `${sign}${pct.toFixed(2)}%`
    }

    function formatPrice(price) {
      if (price === null || price === undefined || Number.isNaN(price)) return '—'
      return price.toFixed(2)
    }

    /** 每秒拉一次快照（引擎侧内存直读，开销可忽略）。 */
    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        let timer = null
        const loop = async () => {
          try {
            const value = await rpc('snapshot')
            if (!alive) return
            setSnapshot(value)
            setError(null)
          } catch (err) {
            if (!alive) return
            setError(err?.message ?? String(err))
          } finally {
            if (alive) timer = setTimeout(loop, 1000)
          }
        }
        loop()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])
      return { snapshot, error }
    }

    function TickerRow({ quote }) {
      const cls = colorClass(quote.changePct)
      return h('div', { className: 'stk-row' },
        h('span', { className: 'stk-name', title: `${quote.name} ${quote.code}` }, quote.name),
        h('span', { className: 'stk-code' }, quote.code),
        h('span', { className: `stk-price ${cls}` }, formatPrice(quote.price)),
        h('span', { className: `stk-pct ${cls}` }, formatPct(quote.changePct)),
      )
    }

    function TickerOverlay({ t }) {
      const { snapshot, error } = useSnapshot()
      const [expanded, setExpanded] = React.useState(false)

      const quotes = snapshot?.quotes ?? []
      const live = snapshot?.live === true
      const phaseLabel = snapshot ? t(`phase.${snapshot.phase}`) : ''
      const agoSec = snapshot?.snapshotAt ? Math.max(0, Math.round((Date.now() - snapshot.snapshotAt) / 1000)) : null
      const head = quotes.find(quote => !quote.missing) ?? quotes[0]

      return h('div', { className: 'stk-overlay' },
        h('style', null, STYLE),
        !expanded
        && h('div', {
          className: 'stk-pill',
          role: 'button',
          title: t('overlay.expand'),
          onClick: () => setExpanded(true),
        },
          h('span', { className: `stk-dot${live ? ' live' : ''}` }),
          head
            ? h(React.Fragment, null,
                h('span', { className: 'stk-name', style: { maxWidth: 72 } }, head.name),
                h('span', { className: `stk-price ${colorClass(head.changePct)}` }, formatPrice(head.price)),
                h('span', { className: `stk-pct ${colorClass(head.changePct)}`, style: { minWidth: 48 } }, formatPct(head.changePct)),
                quotes.length > 1 && h('span', { className: 'stk-code' }, `+${quotes.length - 1}`),
              )
            : h('span', { className: 'stk-name' }, t('overlay.title')),
        ),
        expanded && h('div', { className: 'stk-panel' },
          h('div', { className: 'stk-head' },
            h('span', { className: `stk-dot${live ? ' live' : ''}` }),
            h('span', { className: 'stk-head-title' }, t('overlay.title')),
            snapshot && h('span', { className: 'stk-phase' }, phaseLabel),
            h('button', { className: 'stk-close', title: t('overlay.collapse'), onClick: () => setExpanded(false) }, '✕'),
          ),
          h('div', { className: 'stk-rows' },
            quotes.length === 0
              ? h('div', { className: 'stk-row' }, h('span', { className: 'stk-code' }, error ? t('overlay.offline') : t('overlay.never')))
              : quotes.map(quote => h(TickerRow, { key: quote.code, quote })),
          ),
          h('div', { className: 'stk-foot' },
            snapshot?.enabled === false && h('div', null, t('overlay.disabled')),
            h('div', null,
              snapshot?.fetching
                ? t('overlay.updating')
                : agoSec !== null
                  ? `${t('overlay.updatedAgo').replace('{n}', String(agoSec))} · ${snapshot?.pollSeconds ?? '—'}s`
                  : t('overlay.never'),
            ),
            snapshot?.lastError && h('div', { className: 'stk-err' }, snapshot.lastError),
            !snapshot && error && h('div', { className: 'stk-err' }, error),
          ),
          h('div', { className: 'stk-hint' }, t('overlay.manageHint')),
        ),
      )
    }

    function SettingsPage({ t }) {
      const [settings, setSettings] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [input, setInput] = React.useState('')
      const [resolving, setResolving] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [saveError, setSaveError] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        rpc('settings').then(value => { if (alive) setSettings(value.settings) }).catch(() => {})
        const timer = setInterval(() => {
          rpc('snapshot').then(value => { if (alive) setSnapshot(value) }).catch(() => {})
        }, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      async function save(next) {
        setSaveError(null)
        try {
          const result = await rpc('save', next)
          setSettings(result.settings)
          setNote(result.persisted ? t('settings.saved') : result.note ?? t('settings.saved'))
        } catch (error) {
          setSaveError(`${t('settings.saveFailed')}: ${error?.message ?? error}`)
        }
      }

      async function addSymbol() {
        const input0 = input.trim()
        if (!input0 || resolving) return
        setResolving(true)
        setNote(null)
        setSaveError(null)
        try {
          const resolved = await rpc('resolve', { input: input0 })
          if (!resolved?.ok) {
            setSaveError(resolved?.reason ?? t('settings.saveFailed'))
            return
          }
          const symbols = [...(settings?.symbols ?? [])]
          if (!symbols.includes(resolved.code)) symbols.push(resolved.code)
          setInput('')
          await save({ symbols, pollSeconds: settings.pollSeconds, enabled: settings.enabled })
        } catch (error) {
          setSaveError(error?.message ?? String(error))
        } finally {
          setResolving(false)
        }
      }

      function removeSymbol(code) {
        const symbols = (settings?.symbols ?? []).filter(item => item !== code)
        void save({ symbols, pollSeconds: settings.pollSeconds, enabled: settings.enabled })
      }

      const knownNames = new Map((snapshot?.quotes ?? []).map(quote => [quote.code, quote.name]))

      if (!settings) {
        return h('div', { className: 'stk-page' }, h('span', { className: 'stk-note' }, t('settings.rpcMissing')))
      }

      return h('div', { className: 'stk-page' },
        h('style', null, STYLE),
        // 添加行
        h('div', { className: 'stk-addrow' },
          h('input', {
            className: 'stk-input',
            placeholder: t('settings.inputPlaceholder'),
            value: input,
            onChange: event => setInput(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') void addSymbol() },
          }),
          h('button', { className: 'stk-btn', disabled: resolving || !input.trim(), onClick: () => void addSymbol() },
            resolving ? t('settings.resolving') : t('settings.add')),
        ),
        // 列表
        settings.symbols.length === 0
          ? h('span', { className: 'stk-note' }, t('settings.empty'))
          : h('div', { className: 'stk-list' },
              settings.symbols.map(code => h('div', { className: 'stk-item', key: code },
                h('span', null, knownNames.get(code) ?? code),
                h('span', { className: 'stk-code' }, code),
                h('span', { className: 'stk-badge' }, snapshot?.quotes?.find(quote => quote.code === code)?.source === 'tencent' ? t('settings.source.tencent') : t('settings.source.zhangle')),
                h('button', { className: 'stk-del', title: t('settings.remove'), onClick: () => removeSymbol(code) }, '✕'),
              )),
            ),
        // 间隔
        h('div', { className: 'stk-setting-line' },
          h('label', null, t('settings.intervalLabel')),
          h('select', {
            value: String(settings.pollSeconds),
            onChange: event => void save({ ...settings, pollSeconds: Number(event.target.value) }),
            style: { padding: '5px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
          },
            [1, 2, 3, 5, 10, 15, 30, 60].map(seconds => h('option', { key: seconds, value: String(seconds) }, `${seconds} ${t('settings.seconds')}`)),
          ),
        ),
        // 开关
        h('div', { className: 'stk-setting-line' },
          h('label', null, t('settings.enabledLabel')),
          h('button', {
            className: 'stk-switch',
            role: 'switch',
            'aria-checked': settings.enabled ? 'true' : 'false',
            onClick: () => void save({ ...settings, enabled: !settings.enabled }),
          }),
        ),
        // 快照状态
        snapshot && h('span', { className: 'stk-note' },
          `${snapshot.phaseLabel} · ${snapshot.quotes.length} 只 · ${snapshot.live ? `${snapshot.pollSeconds}s` : '—'}`,
        ),
        note && h('span', { className: 'stk-note' }, note),
        saveError && h('span', { className: 'stk-note-err' }, saveError),
      )
    }

    function makeTranslator(ctx) {
      try {
        if (ctx.locale?.register && ctx.locale?.bind) {
          const disposeRegister = ctx.locale.register(NS, { zh, en })
          const bound = ctx.locale.bind(NS)
          const t = key => {
            const translated = bound(key)
            return typeof translated === 'string' && translated.length > 0 ? translated : (zh[key] ?? key)
          }
          return { t, disposeRegister }
        }
      } catch { /* fall through */ }
      const fallback = key => zh[key] ?? key
      return { t: fallback, disposeRegister: null }
    }

    return {
      // Client 侧与 Host 一样有 inject 门控：不声明就直接访问 ctx.slots / ctx.locale
      // 会抛 "cannot get property ... without inject"，导致 client entry 变 failed，
      // 宿主 renderer 的 boot 检查随之失败（整个 App 起不来）。
      inject: ['slots', 'locale'],
      apply(ctx) {
        console.error('[stock-ticker] apply enter | slots=', typeof ctx.slots, 'locale=', typeof ctx.locale)
        try {
          const { t, disposeRegister } = makeTranslator(ctx)
          console.error('[stock-ticker] translator ready, dispose=', typeof disposeRegister)
          if (disposeRegister) ctx.effect(() => disposeRegister, 'stock-ticker: locale')

          ctx.slots.inject('shell.overlay', () => ctx.slots.register(
            { name: 'shell.overlay', id: 'stock-ticker', order: 90, label: () => t('meta.title') },
            () => h(TickerOverlay, { t }),
          ))
          console.error('[stock-ticker] overlay registered')
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
            { name: 'settings.plugins.tab', id: 'stock-ticker', order: 50, label: () => t('meta.title') },
            () => h(SettingsPage, { t }),
          ))
          console.error('[stock-ticker] settings tab registered')
        } catch (error) {
          console.error('[stock-ticker] APPLY THREW: ' + String(error && error.stack ? error.stack : error))
          throw error
        }
      },
    }
  },
})
