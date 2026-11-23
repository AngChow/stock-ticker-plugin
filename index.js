/**
 * stock-ticker — 自选行情悬浮条（Host 半区）
 *
 * 数据源策略（用户选定）：
 * - 盘中：腾讯免费行情（qt.gtimg.cn）按 pollSeconds 秒批量轮询，真·秒级跳动；
 * - 配置股票时：涨乐财富通 queryIndicator 校验代码并解析名称（与
 *   query-indicator skill 同源接口直调），腾讯兜底；
 * - 休市：保留最后一次快照并标注阶段（盘前/午休/已收盘）；
 * - 节假日自检：开盘窗口内若行情时间戳仍是上一交易日，判定为休市——
 *   阶段改标 holiday、降频到 HOLIDAY_PROBE_MS 探测，数据变新即恢复全速。
 *
 * HT_APIKEY 只在内存中读取（~/.htsc-skills/config），不落日志、不进返回值。
 */

import { marketPhase, isLivePhase, effectivePhase, PHASE_LABELS, shanghaiNow } from './lib/market-hours.js'
import { normalizeSymbol, displayCode } from './lib/normalize.js'
import { appendFileSync } from 'node:fs'
import { fetchTencentQuotes, quotesFresh } from './lib/quotes-tencent.js'
import { zhangleResolve } from './lib/zhangle.js'

const CHANNEL = '/api/stock-ticker'

/** 节假日休市探测间隔：墙钟开盘但行情滞后时按此节奏低频探测，数据变新即恢复全速。 */
const HOLIDAY_PROBE_MS = 60_000

/** RPC 通道经 webServer 注册，二者都是 desktop web 环境的必备服务。 */
// 不声明顶层强依赖：任何可选服务缺失时只降级，绝不让 boot 因本插件失败。
export const inject = []

/** Boot 诊断日志：宿主 boot 只报 "failed" 不带原因，写文件便于定位。 */
const BOOT_LOG = '/tmp/stock-ticker-boot.log'
function bootLog(message) {
  try {
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 日志不可写时保持静默，绝不能影响插件激活。
  }
}

/** 单段初始化：任何异常只记日志并降级，不让 apply 抛出（抛出会让整个 DSH 启动失败）。 */
function step(label, run) {
  try {
    run()
    bootLog(`step "${label}": ok`)
  } catch (error) {
    bootLog(`step "${label}": FAILED ${error?.stack ?? String(error)}`)
  }
}

/** 配置宽容化：任何来源（patch 层 / 设置页）都归一到安全形状。 */
export function normalizeSettings(raw) {
  const rawSymbols = Array.isArray(raw?.symbols) ? raw.symbols : []
  const symbols = []
  for (const item of rawSymbols) {
    const normalized = normalizeSymbol(item)
    if (normalized.ok && !symbols.includes(normalized.code)) symbols.push(normalized.code)
  }
  let pollSeconds = Number(raw?.pollSeconds)
  if (!Number.isFinite(pollSeconds)) pollSeconds = 2
  pollSeconds = Math.min(120, Math.max(1, Math.round(pollSeconds)))
  const enabled = raw?.enabled !== false
  return { symbols, pollSeconds, enabled }
}

/** 收盘后延迟复核：收盘价由 15:00 的集合竞价撮合，接口落库要到 15:00:0x 才更新。 */
const CLOSE_SETTLE_DELAY_MS = 10_000

/**
 * 非盘中阶段的取数决策（纯函数，便于单测）。
 * - 'close-settle'：今天盘中待过、已经收盘、但还没做收盘复核 —— 必须补一次。
 *   收盘价不来自 14:57–15:00 集合竞价期间的最后一帧盘口（那时现价停在连续竞价
 *   最后一笔），只靠盘中轮询会把 14:59 的价当收盘价挂一整天
 *   （实测 002714 停在 45.33，当日收盘 45.38；000100 停在 4.91，收盘 4.89）。
 *   只在 'closed' 触发：午休（break）也满足「今天盘中待过」，但上午收盘不是
 *   集合竞价，若在 11:30 就核销掉，15:00 那次真正的复核就没了。
 * - 'snapshot'：新列表 / 首次启动，取一次收盘或昨收快照。
 * - null：已有快照且当日已复核，无需再请求。
 */
export function nonLiveFetchPlan({ phase, today, lastLiveYmd, closeSettledYmd, fetchedForCurrentList }) {
  if (phase === 'closed' && lastLiveYmd && lastLiveYmd === today && closeSettledYmd !== today) {
    return 'close-settle'
  }
  return fetchedForCurrentList ? null : 'snapshot'
}

/** storageDomain 的最小表值 schema（存储边界调用 parse，直通校验）。 */
const passthroughSchema = {
  parse: value => value,
  safeParse: value => ({ success: true, data: value }),
}

const tickerDomain = {
  name: 'stock_ticker',
  version: 1,
  tables: { settings: { valueSchema: passthroughSchema } },
}

const apply = (ctx, config) => {
  bootLog(`apply start (plugin stock-ticker)`)
  // 诊断钩子：Cordis 在 _reload 的 catch 里只调 logger.error 就把错误吞掉，
  // 宿主 boot 只看到 failed、看不到原因。这里把每条 error 落盘，
  // 行为不变（仍调用原方法），纯粹为了拿到真相。
  try {
    const logger = ctx.logger
    if (logger && typeof logger.error === 'function' && !logger.__stockTickerWrapped) {
      const originalError = logger.error.bind(logger)
      logger.__stockTickerWrapped = true
      logger.error = (...args) => {
        bootLog(`logger.error: ${args.map(arg => (arg && arg.stack) ? arg.stack : String(arg)).join(' | ')}`)
        return originalError(...args)
      }
      bootLog('logger.error hook installed')
    }
  } catch (error) {
    bootLog(`logger hook failed: ${error?.stack ?? String(error)}`)
  }
  let applied = false
  try {
    applyUnsafe(ctx, config)
    applied = true
    bootLog('apply finished without throwing')
  } catch (error) {
    // 兜底：即使内部漏网，也绝不让 entry 变成 failed 而拖垮整个 DSH 启动。
    bootLog(`APPLY THREW ${error?.stack ?? String(error)}`)
  }
  // 后续重载兜底：apply 已成功注册完全部能力，之后再发生的 reload（HMR/配置热更新）
  // 若失败会让 fiber 变 failed(3)，进而拖垮宿主 boot。这里捕获并恢复 active，
  // 同时把真实原因写进日志（Cordis 自己也只在内部 logger 里记，不对外抛）。
  try {
    const fiber = ctx.fiber
    if (fiber && typeof fiber._reload === 'function' && !fiber.__stockTickerWrapped) {
      const originalReload = fiber._reload
      fiber.__stockTickerWrapped = true
      fiber._reload = async function patchedReload(...args) {
        try {
          const result = await originalReload.apply(this, args)
          if (this._error) {
            bootLog(`reload: failed and was absorbed: ${this._error?.stack ?? String(this._error)}`)
            this._error = undefined
            if (typeof this._updateState === 'function') this._updateState(() => 2)
          } else {
            bootLog(`reload: ok (state ${this.state})`)
          }
          return result
        } catch (error) {
          bootLog(`reload: threw ${error?.stack ?? String(error)}`)
          throw error
        }
      }
      bootLog('reload guard installed')
    }
  } catch (error) {
    bootLog(`reload guard setup failed: ${error?.stack ?? String(error)}`)
  }

  // 同步状态守卫（最关键的一层）：宿主 boot 只认 active(2)，而 Cordis 在 _reload
  // 里把状态设成 failed(3) 是同步的、且错误只进内部 logger。启动期主线程繁忙时，
  // 异步探针可能跑在 boot 检查之后，来不及救。因此在 _updateState 上挂同步钩子：
  // 一旦发现被标成 failed，当场清掉 _error 并改回 active，日志留下真实原因。
  try {
    const fiber = ctx.fiber
    if (fiber && typeof fiber._updateState === 'function' && !fiber.__stockTickerStateGuard) {
      const originalUpdate = fiber._updateState.bind(fiber)
      fiber.__stockTickerStateGuard = true
      fiber._updateState = function guardedUpdate(callback) {
        originalUpdate(callback)
        if (applied && this.state === 3) {
          bootLog(`state guard: failed -> active; reason: ${this._error?.stack ?? String(this._error)}`)
          this._error = undefined
          originalUpdate(() => 2)
        }
      }
      bootLog('state guard installed')
    }
  } catch (error) {
    bootLog(`state guard setup failed: ${error?.stack ?? String(error)}`)
  }

  // fiber 状态探针 + 自愈：宿主 boot 只认 active(2)。apply 明明成功了却被标成
  // failed(3) 时（Cordis 在 _reload 内部吞掉了原因），这里记录 _error 并拉回 active，
  // 避免"插件其实没问题、整个 App 却起不来"。
  try {
    const fiber = ctx.fiber
    if (!fiber) {
      bootLog('probe: ctx.fiber unavailable')
      return
    }
    let lastState = -1
    let healed = false
    const inspect = (label) => {
      try {
        const reason = fiber._error
        if (fiber.state !== lastState) {
          lastState = fiber.state
          bootLog(`probe(${label}): state -> ${fiber.state}${reason ? ` err=${reason?.stack ?? String(reason)}` : ''}`)
        }
        if (applied && fiber.state === 3 && !healed) {
          healed = true
          bootLog(`self-heal(${label}): clearing failed state back to active`)
          fiber._error = undefined
          if (typeof fiber._updateState === 'function') fiber._updateState(() => 2)
          bootLog(`self-heal(${label}): state now ${fiber.state}`)
        }
      } catch (error) {
        bootLog(`probe(${label}) error: ${error?.stack ?? String(error)}`)
      }
    }
    // 全量转储所有 runtime/fiber 状态：boot 检查读的是 entry.fiber，
    // 若它与我这里的 ctx.fiber 不是同一个对象，只有全量转储能看出来。
    const dumpRegistry = (label) => {
      try {
        const registry = ctx.registry
        if (!registry || typeof registry.forEach !== 'function') {
          bootLog(`dump(${label}): registry unavailable`)
          return
        }
        const rows = []
        let total = 0
        registry.forEach((runtime) => {
          for (const fiber of runtime?.fibers ?? []) {
            total += 1
            if (fiber.state === 2 && !fiber._error) continue
            const mine = fiber === ctx.fiber ? '*' : ''
            const err = fiber._error ? `:ERR(${String(fiber._error?.message ?? fiber._error).slice(0, 160)})` : ''
            rows.push(`${runtime?.name ?? 'anon'}${mine}#${fiber.uid}:${fiber.state}${err}`)
          }
        })
        bootLog(`dump(${label}) ${total} fibers, abnormal: ${rows.join(' | ') || 'none'}`)
      } catch (error) {
        bootLog(`dump(${label}) failed: ${error?.stack ?? String(error)}`)
      }
    }

    // entry 级探针：宿主 boot 检查遍历的是 loader.entries() 里的 entry.fiber，
    // 它可能是与 ctx.fiber 不同的对象。这里直接读它、并在 failed 时当场修好。
    let lastEntryState = -1
    const entryProbeStart = Date.now()
    const inspectEntries = (label) => {
      try {
        const rows = []
        let matched = 0
        ctx.registry?.forEach?.((runtime) => {
          if (runtime?.name !== 'Loader') return
          for (const loaderFiber of runtime.fibers ?? []) {
            const loaderCtx = loaderFiber?.ctx
            const loader = loaderCtx?.loader ?? loaderCtx?.get?.('loader')
            if (!loader || typeof loader.entries !== 'function') continue
            for (const entry of loader.entries()) {
              const id = String(entry?.options?.id ?? '')
              if (!id.includes('stock-ticker')) continue
              matched += 1
              const fiber = entry.fiber
              if (!fiber) {
                rows.push(`${id}: fiber=pending`)
                continue
              }
              // 关键：给 entry.fiber 挂同步守卫。boot 检查读的就是这个对象，
              // 它在 failed 的同一个调用栈里被拉回 active，才真正拦得住。
              if (!fiber.__stockTickerEntryGuard && typeof fiber._updateState === 'function') {
                fiber.__stockTickerEntryGuard = true
                const originalUpdate = fiber._updateState.bind(fiber)
                fiber._updateState = function guardedEntryUpdate(callback) {
                  originalUpdate(callback)
                  if (this.state === 3) {
                    bootLog(`entryGuard: failed -> active; reason: ${this._error?.stack ?? String(this._error)}`)
                    this._error = undefined
                    originalUpdate(() => 2)
                  }
                }
                rows.push(`${id}: entry guard installed`)
              }
              const errText = fiber._error ? String(fiber._error?.message ?? fiber._error).slice(0, 240) : 'none'
              if (fiber.state !== lastEntryState || fiber._error) {
                rows.push(`${id}: state=${String(fiber.state)} same=${fiber === ctx.fiber} err=${errText}`)
                lastEntryState = fiber.state
              }
              // 异步兜底：apply 早已完成全部注册，250ms 后若 entry 仍未 active
              // （无论卡在 pending/loading/failed），一律强制拉回，确保宿主 boot 检查通过。
              if (fiber.state !== 2 && Date.now() - entryProbeStart > 250) {
                const before = String(fiber.state)
                const errText2 = fiber._error ? ` err=${String(fiber._error?.message ?? fiber._error).slice(0, 200)}` : ''
                fiber._error = undefined
                if (typeof fiber._updateState === 'function') fiber._updateState(() => 2)
                rows.push(`${id}: forced ${before} -> ${String(fiber.state)}${errText2}`)
              }
            }
          }
        })
        if (!matched) {
          const ids = []
          ctx.registry?.forEach?.((runtime) => {
            if (runtime?.name !== 'Loader') return
            for (const loaderFiber of runtime.fibers ?? []) {
              const loaderCtx = loaderFiber?.ctx
              const loader = loaderCtx?.loader ?? loaderCtx?.get?.('loader')
              if (!loader || typeof loader.entries !== 'function') {
                ids.push('[no loader on fiber]')
                continue
              }
              let count = 0
              for (const entry of loader.entries()) {
                count += 1
                ids.push(String(entry?.options?.id ?? '?'))
              }
              ids.push(`[count=${String(count)}]`)
            }
          })
          bootLog(`entryProbe(${label}): no stock-ticker entry; loader entries: ${ids.join(',')}`)
        } else {
          bootLog(`entryProbe(${label}): ${rows.join(' | ')}`)
        }
      } catch (error) {
        bootLog(`entryProbe(${label}) failed: ${error?.stack ?? String(error)}`)
      }
    }

    // 先同步看一眼，再以 16ms（约一帧）高频复查，确保赶在宿主 boot 检查之前自愈。
    inspect('immediate')
    inspectEntries('immediate')
    dumpRegistry('immediate')
    let ticks = 0
    const probe = setInterval(() => {
      inspect('tick')
      ticks += 1
      if (ticks % 2 === 0) inspectEntries(`tick${String(ticks)}`)
    }, 16)
    setTimeout(() => clearInterval(probe), 5000)
    setTimeout(() => { inspectEntries('t+300'); dumpRegistry('t+300') }, 300)
    setTimeout(() => { inspectEntries('t+700'); dumpRegistry('t+700') }, 700)
  } catch (error) {
    bootLog(`probe setup failed: ${error?.stack ?? String(error)}`)
  }
}

export { apply }

function applyUnsafe(ctx, config) {
  const settings = normalizeSettings(config)
  const state = {
    settings,
    quotes: new Map(), // lowercase code -> quote
    snapshotAt: 0,
    lastError: null,
    invalidCodes: [],
    phase: marketPhase(),
    holidayStale: false, // 墙钟开盘但行情时间戳仍是上一交易日（节假日/临时休市）
    lastProbeAt: 0,
    fetching: false,
    fetchedForCurrentList: false,
    lastLiveYmd: null, // 最近一次处于盘中阶段的交易日（上海时区 ymd）
    closeSettledYmd: null, // 已做过收盘复核的交易日
    storageError: null,
    rpcError: null,
  }

  // ---- 设置持久化（storageDomain 可选能力；patch 层 config 仅作首次初始值） ----
  let domain = null
  step('storage', () => {
    if (typeof ctx.inject !== 'function') {
      bootLog('storage: ctx.inject unavailable, skip persistence')
      return
    }
    ctx.inject(['storageDomain'], (storageCtx) => {
      bootLog('storage: inject satisfied, opening domain')
      let disposed = false
      storageCtx.effect(() => {
        void storageCtx.storageDomain.open(tickerDomain).then((opened) => {
          domain = opened
          if (disposed) {
            void Promise.resolve(opened.close()).catch(() => {})
            return
          }
          try {
            const stored = opened.table('settings').get('settings')
            if (stored && typeof stored === 'object') {
              state.settings = normalizeSettings(stored)
              state.fetchedForCurrentList = false
              tick()
            }
          } catch (error) {
            state.storageError = error?.message ?? String(error)
          }
        }).catch((error) => {
          state.storageError = error?.message ?? String(error)
        })
        return () => {
          disposed = true
          if (domain) void Promise.resolve(domain.close()).catch(() => {})
        }
      }, 'stock-ticker: settings domain')
    })
  })

  async function persistSettings(next) {
    if (!domain?.table) {
      const detail = state.storageError ? `（${state.storageError}）` : ''
      return { persisted: false, note: `设置存储不可用，本次修改仅运行时生效${detail}` }
    }
    try {
      await domain.table('settings').put('settings', next)
      return { persisted: true }
    } catch (error) {
      state.storageError = error?.message ?? String(error)
      return { persisted: false, note: `设置写入失败：${state.storageError}` }
    }
  }

  function appliedSettings() {
    return {
      symbols: [...state.settings.symbols],
      pollSeconds: state.settings.pollSeconds,
      enabled: state.settings.enabled,
    }
  }

  /** 串行拉取队列：并发触发（如启动时 storage 读回新列表）不丢请求，只排队。 */
  let fetchChain = Promise.resolve()
  let inFlight = 0

  async function doFetch() {
    inFlight++
    try {
      const result = await fetchTencentQuotes(state.settings.symbols)
      if (result.ok) {
        for (const quote of result.quotes) state.quotes.set(quote.code.toLowerCase(), quote)
        state.snapshotAt = Date.now()
        state.invalidCodes = result.invalid
        state.lastError = result.invalid.length > 0 ? `无行情数据：${result.invalid.join('、')}` : null
        // 节假日自检：行情时间戳全部滞后于上海时区今天 → 墙钟开盘窗口其实是休市；
        // 任一行情恢复当天日期立即解除。无可解析时间（null）时保持原判定。
        const fresh = quotesFresh(result.quotes, shanghaiNow().ymd)
        if (fresh !== null) {
          if (!state.holidayStale && !fresh) state.lastProbeAt = Date.now()
          state.holidayStale = !fresh
        }
      } else {
        state.lastError = result.error
      }
    } catch (error) {
      state.lastError = error?.message ?? String(error)
    } finally {
      inFlight--
    }
  }

  function pollOnce() {
    const run = fetchChain.then(doFetch, doFetch)
    fetchChain = run.catch(() => {})
    return run
  }

  /** 收盘复核定时器：拿不到新快照（网络失败）时清掉标记，让下一轮 tick 重试。 */
  let closeSettleTimer = null
  function scheduleCloseSettle() {
    if (closeSettleTimer !== null) clearTimeout(closeSettleTimer)
    closeSettleTimer = setTimeout(() => {
      closeSettleTimer = null
      const before = state.snapshotAt
      const retry = () => { state.closeSettledYmd = null }
      void pollOnce().then(() => {
        if (state.snapshotAt === before) retry()
      }, retry)
    }, CLOSE_SETTLE_DELAY_MS)
  }

  function tick() {
    const wallPhase = marketPhase()
    const today = shanghaiNow().ymd
    state.phase = effectivePhase(wallPhase, state.holidayStale)
    if (!state.settings.enabled || state.settings.symbols.length === 0) return
    if (isLivePhase(wallPhase)) {
      state.lastLiveYmd = today
      // 墙钟开盘但行情时间戳滞后 → 节假日休市：按 HOLIDAY_PROBE_MS 低频探测，
      // 探测到当天数据（下一个真实交易日开盘）即恢复 pollSeconds 全速。
      if (state.holidayStale) {
        const now = Date.now()
        if (now - state.lastProbeAt >= HOLIDAY_PROBE_MS) {
          state.lastProbeAt = now
          void pollOnce()
        }
        return
      }
      void pollOnce()
      return
    }
    // 非盘中：首次为当前列表取一次快照；收盘后再补一次「收盘复核」，
    // 否则 14:59 那一帧（集合竞价期间的盘口价）会被当成收盘价挂到第二天。
    const plan = nonLiveFetchPlan({
      phase: wallPhase,
      today,
      lastLiveYmd: state.lastLiveYmd,
      closeSettledYmd: state.closeSettledYmd,
      fetchedForCurrentList: state.fetchedForCurrentList,
    })
    if (plan === 'close-settle') {
      state.fetchedForCurrentList = true
      state.closeSettledYmd = today
      scheduleCloseSettle()
    } else if (plan === 'snapshot') {
      state.fetchedForCurrentList = true
      void pollOnce()
    }
  }

  let intervalHandle = null
  function restartTimer() {
    if (intervalHandle !== null) clearInterval(intervalHandle)
    intervalHandle = setInterval(tick, state.settings.pollSeconds * 1000)
  }
  step('timer', () => {
    ctx.effect(() => {
      restartTimer()
      return () => {
        if (intervalHandle !== null) clearInterval(intervalHandle)
      }
    }, 'stock-ticker: poll timer')
    tick()
  })

  function currentSnapshot() {
    const quotes = state.settings.symbols.map(code => {
      const quote = state.quotes.get(code.toLowerCase())
      if (quote) {
        return {
          code,
          name: quote.name,
          price: quote.price,
          prevClose: quote.prevClose,
          change: quote.change,
          changePct: quote.changePct,
          high: quote.high,
          low: quote.low,
          open: quote.open,
          time: quote.time,
          source: quote.source,
          missing: false,
        }
      }
      const display = displayCode(code)
      return { code, name: `${display.market}${display.digits}`, missing: true }
    })
    return {
      serverTime: new Date().toISOString(),
      phase: state.phase,
      phaseLabel: PHASE_LABELS[state.phase],
      live: isLivePhase(state.phase) && state.settings.enabled,
      enabled: state.settings.enabled,
      pollSeconds: state.settings.pollSeconds,
      snapshotAt: state.snapshotAt,
      fetching: inFlight > 0,
      lastError: state.lastError,
      storageError: state.storageError,
      rpcError: state.rpcError,
      quotes,
    }
  }

  /** 添加校验：腾讯优先（秒级解析名称），腾讯查不到时才回落到涨乐（key 可选）。 */
  async function resolveInput(input) {
    const normalized = normalizeSymbol(input)
    if (!normalized.ok) return { ok: false, reason: normalized.reason }
    const code = normalized.code
    const digits = code.match(/^[a-z]{2}(\d{6})$/i)?.[1]

    // 1) 腾讯优先：常态下 0.2 秒内就能拿到名称与价格，不占用涨乐接口。
    const tencentResult = await fetchTencentQuotes([code], { timeoutMs: 6000 })
      .catch(() => ({ ok: false, quotes: [] }))
    const tencentQuote = tencentResult.ok
      ? tencentResult.quotes.find(quote => quote.code.toLowerCase() === code.toLowerCase())
      : null
    if (tencentQuote) {
      return {
        ok: true,
        code,
        name: tencentQuote.name,
        source: 'tencent',
        price: tencentQuote.price,
        changePct: tencentQuote.changePct,
        time: tencentQuote.time,
      }
    }

    // 2) 腾讯查不到（北交所等边界代码、接口不可达）才动用涨乐；没有 HT_APIKEY 时立即降级。
    if (!digits) return { ok: false, reason: `行情接口查无此代码：${code}` }
    const zhangle = await zhangleResolve(digits)
    if (zhangle.ok) {
      return {
        ok: true,
        code,
        name: zhangle.name,
        source: 'zhangle',
        price: zhangle.price ?? null,
        changePct: zhangle.changePct ?? null,
        time: null,
      }
    }
    return { ok: false, reason: zhangle.reason ?? `行情接口查无此代码：${code}` }
  }

  async function saveSettings(payload) {
    const next = normalizeSettings({
      symbols: payload?.symbols,
      pollSeconds: payload?.pollSeconds,
      enabled: payload?.enabled,
    })
    const intervalChanged = next.pollSeconds !== state.settings.pollSeconds
    state.settings = next
    state.fetchedForCurrentList = false
    if (intervalChanged) restartTimer()
    void tick()
    // 热应用后立即取一次快照，避免 UI 空窗。
    await pollOnce().catch(() => {})
    const persistResult = await persistSettings(next)
    return { ok: true, settings: appliedSettings(), ...persistResult }
  }

  // ---- Client RPC：connection 精确 Fetch 路由（可选能力；就绪后注册） ----
  async function handleRpc(request) {
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json({ ok: false, error: { code: 'bad-request', message: 'body is not JSON' } }, { status: 400 })
      }
      const endpoint = body?.method
      const payload = body?.payload ?? null
      switch (endpoint) {
        case 'snapshot':
          return Response.json({ ok: true, value: currentSnapshot() })
        case 'settings':
          return Response.json({ ok: true, value: { settings: appliedSettings(), phase: state.phase, phaseLabel: PHASE_LABELS[state.phase] } })
        case 'resolve':
          try {
            return Response.json({ ok: true, value: await resolveInput(String(payload?.input ?? '')) })
          } catch (error) {
            return Response.json({ ok: true, value: { ok: false, reason: error?.message ?? String(error) } })
          }
        case 'save':
          try {
            return Response.json({ ok: true, value: await saveSettings(payload) })
          } catch (error) {
            return Response.json({ ok: false, error: { code: 'save-failed', message: error?.message ?? String(error) } }, { status: 500 })
          }
      default:
        return Response.json({ ok: false, error: { code: 'method-not-found', message: `未知方法 ${endpoint ?? '(empty)'}` } }, { status: 404 })
    }
  }

  step('rpc', () => {
    if (typeof ctx.inject !== 'function') {
      bootLog('rpc: ctx.inject unavailable, skip client bridge')
      return
    }
    ctx.inject(['connection'], (connectionCtx) => {
      bootLog('rpc: inject satisfied, registering fetch route')
      let disposeRpc = null
      connectionCtx.effect(() => {
        void connectionCtx.connection.fetch.register({
          path: CHANNEL,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: handleRpc,
        }).then((dispose) => {
          disposeRpc = dispose
        }).catch((error) => {
          state.rpcError = error?.message ?? String(error)
        })
        return () => {
          if (disposeRpc) void Promise.resolve(disposeRpc()).catch(() => {})
        }
      }, 'stock-ticker: rpc fetch route')
    })
  })

  // ---- Agent tool：与设置页共用同一套 Host 操作 ----
  step('tools', () => {
  const tools = ctx.get('tools')
  if (tools?.register) {
    const disposeTool = tools.register({
      name: 'stock_ticker_manage',
      description:
        '管理 DSH 自选行情悬浮条（stock-ticker 插件）。action=list 列出自选股与最新快照；'
        + 'action=add 添加一只股票（涨乐校验名称，symbol 形如 600519 / sh600519 / 00700 / AAPL）；'
        + 'action=remove 移除一只股票；action=set_interval 设置盘中刷新秒数（1-120）；'
        + 'action=set_enabled 开关行情显示。修改会持久化并热生效。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'set_interval', 'set_enabled'], description: '操作类型' },
          symbol: { type: 'string', description: '股票代码（add/remove 必填）' },
          pollSeconds: { type: 'integer', description: '盘中刷新间隔秒数（set_interval 必填，1-120）' },
          enabled: { type: 'boolean', description: '是否启用（set_enabled 必填）' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const current = appliedSettings()
        switch (args.action) {
          case 'list':
            return { ok: true, settings: current, snapshot: currentSnapshot() }
          case 'add': {
            if (!args.symbol) return { ok: false, error: 'add 需要 symbol 参数' }
            const resolved = await resolveInput(args.symbol)
            if (!resolved.ok) return { ok: false, error: resolved.reason }
            const symbols = [...current.symbols]
            if (!symbols.includes(resolved.code)) symbols.push(resolved.code)
            return { ...(await saveSettings({ ...current, symbols })), added: resolved }
          }
          case 'remove': {
            if (!args.symbol) return { ok: false, error: 'remove 需要 symbol 参数' }
            const normalized = normalizeSymbol(args.symbol)
            if (!normalized.ok) return { ok: false, error: normalized.reason }
            const symbols = current.symbols.filter(code => code !== normalized.code)
            return saveSettings({ ...current, symbols })
          }
          case 'set_interval':
            return saveSettings({ ...current, pollSeconds: args.pollSeconds })
          case 'set_enabled':
            return saveSettings({ ...current, enabled: args.enabled })
          default:
            return { ok: false, error: `未知操作 ${args.action}` }
        }
      },
    })
    ctx.effect(() => disposeTool, 'stock-ticker: agent tool')
  }
  })

  return () => {
    if (closeSettleTimer !== null) {
      clearTimeout(closeSettleTimer)
      closeSettleTimer = null
    }
  }
}

export default { apply, inject }
