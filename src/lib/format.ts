/**
 * 时间与约束的展示辅助函数
 */

const MINUTE_MS = 60_000

/** datetime-local 字符串（本地时区）→ 距 Unix 纪元的分钟数；无效输入返回 null */
export function localToEpochMin(iso: string): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.round(t / MINUTE_MS)
}

/** 距 Unix 纪元的分钟数 → 本地时区的 datetime-local 字符串（yyyy-MM-ddTHH:mm） */
export function epochMinToLocal(m: number): string {
  const d = new Date(m * MINUTE_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 把分钟偏移格式化为 “+12 分钟 / -5 分钟 / 0” */
export function formatOffset(min: number | null): string {
  if (min === null) return '—'
  if (min === 0) return '0（同时）'
  const sign = min > 0 ? '+' : '−'
  return `${sign}${Math.abs(min)} 分钟`
}

/** 偏移的自然语言描述（相对参照时刻） */
export function offsetRelation(min: number | null): string {
  if (min === null) return '无界'
  if (min === 0) return '与参照时刻同时'
  return min > 0 ? `晚于参照时刻 ${min} 分钟` : `早于参照时刻 ${-min} 分钟`
}

/** 绝对时刻（纪元分钟数）格式化为 “YYYY-MM-DD HH:mm”；无界时返回 — */
export function formatEpochMin(min: number | null): string {
  if (min === null) return '—'
  const t = new Date(min * MINUTE_MS)
  if (Number.isNaN(t.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** 在 datetime-local 时间上叠加分钟偏移，返回 datetime-local 格式 */
export function plusMinutesISO(iso: string, min: number): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  t.setMinutes(t.getMinutes() + min)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** 约束的自然语言：事件 A 比事件 B 早/晚 x~y 分钟 */
export function describeConstraint(
  c: { aId: string; bId: string; relation: 'earlier' | 'later'; min: number; max: number },
  nameOf: (id: string) => string,
): string {
  const a = nameOf(c.aId) || '（已删除事件）'
  const b = nameOf(c.bId) || '（已删除事件）'
  const rel = c.relation === 'earlier' ? '早于' : '晚于'
  const range = c.min === c.max ? `${c.min}` : `${c.min}~${c.max}`
  return `「${a}」${rel}「${b}」 ${range} 分钟`
}

/** 观测区间的自然语言：事件 时刻在 最早 ~ 最晚 之间（精确时刻退化为单点） */
export function describeObservation(
  o: { earliest: string; latest: string },
  eventName: string,
): string {
  const lo = formatEpochMin(localToEpochMin(o.earliest))
  const hi = formatEpochMin(localToEpochMin(o.latest))
  if (lo === hi) return `「${eventName}」精确发生于 ${lo}`
  return `「${eventName}」发生于 ${lo} ~ ${hi} 之间`
}
