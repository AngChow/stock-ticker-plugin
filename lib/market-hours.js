/**
 * A 股交易时段判断（Asia/Shanghai）。
 * 墙钟只认「周一至周五 + 时段」；法定节假日与临时休市由行情时间戳自检兜底：
 * 盘中窗口内拉到的行情日期仍是上一交易日时，index.js 会把阶段改标为 holiday
 * 并降频探测（见 effectivePhase）。本模块只负责墙钟与阶段映射，不做任何 IO。
 *
 * 重要：本模块顶层不得有任何可能抛错的副作用。宿主（Electron）的 ICU 时区
 * 数据未必完整，`new Intl.DateTimeFormat(..., { timeZone: 'Asia/Shanghai' })`
 * 若在模块加载期抛 RangeError，会让整个插件的 import 失败、进而拖垮宿主启动。
 * 因此格式化器惰性创建，失败时退回 UTC+8 固定偏移的纯算术实现。
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 东八区固定偏移（中国自 1991 年起无夏令时，偏移恒为 +08:00）。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

let partsFormatter = null
let intlUnavailable = false

function intlParts(now) {
  if (intlUnavailable) return null
  try {
    partsFormatter ??= new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
    return Object.fromEntries(
      partsFormatter.formatToParts(now).map(part => [part.type, part.value]),
    )
  } catch {
    intlUnavailable = true
    return null
  }
}

function fallbackParts(now) {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const pad = value => String(value).padStart(2, '0')
  return {
    year: String(shifted.getUTCFullYear()),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
    second: pad(shifted.getUTCSeconds()),
    weekday: WEEKDAYS[shifted.getUTCDay()],
  }
}

/** 当前时刻映射到上海时区的日期与分钟数。 */
export function shanghaiNow(now = new Date()) {
  const parts = intlParts(now) ?? fallbackParts(now)
  const hour = Number(parts.hour === '24' ? 0 : parts.hour)
  const minute = Number(parts.minute)
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hhmmss: `${parts.hour}:${parts.minute}:${parts.second}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS.indexOf(parts.weekday),
  }
}

/**
 * 市场阶段：
 * - open   盘中（09:30-11:30 / 13:00-15:00，周一至周五）
 * - break  午间休市（11:30-13:00）
 * - pre    盘前（00:00-09:30 的交易日）
 * - closed 已收盘 / 周末休市
 * - holiday 展示态：墙钟盘中但行情时间戳仍是上一交易日（见 effectivePhase）
 */
export function marketPhase(now = new Date()) {
  const { minutes, weekday } = shanghaiNow(now)
  if (weekday === 0 || weekday === 6) return 'closed'
  if (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) return 'open'
  if (minutes >= 13 * 60 && minutes < 15 * 60) return 'open'
  if (minutes >= 11 * 60 + 30 && minutes < 13 * 60) return 'break'
  if (minutes < 9 * 60 + 30) return 'pre'
  return 'closed'
}

/** 是否应当按 pollSeconds 的节奏持续拉取实时行情（holiday 是展示态，绝不全速轮询）。 */
export function isLivePhase(phase) {
  return phase === 'open'
}

/** 展示用阶段映射：墙钟开盘但行情时间戳滞后（节假日/临时休市）→ holiday。 */
export function effectivePhase(wallPhase, holidayStale) {
  return wallPhase === 'open' && holidayStale ? 'holiday' : wallPhase
}

export const PHASE_LABELS = {
  open: '盘中',
  break: '午间休市',
  pre: '盘前',
  closed: '已收盘',
  holiday: '休市（节假日）',
}