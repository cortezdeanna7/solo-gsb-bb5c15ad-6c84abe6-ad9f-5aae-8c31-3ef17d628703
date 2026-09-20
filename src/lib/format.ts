/**
 * 时间与约束的展示辅助函数
 */

/** 把分钟偏移格式化为 “+12 分钟 / -5 分钟 / 0” */
export function formatOffset(min: number | null): string {
  if (min === null) return '—'
  if (min === 0) return '0（同时）'
  const sign = min > 0 ? '+' : '−'
  return `${sign}${Math.abs(min)} 分钟`
}

/** 偏移的自然语言描述 */
export function offsetRelation(min: number | null): string {
  if (min === null) return '无界'
  if (min === 0) return '与锚点同时'
  return min > 0 ? `晚于锚点 ${min} 分钟` : `早于锚点 ${-min} 分钟`
}

/** 在锚点时间上叠加分钟偏移，返回 “MM-DD HH:mm” 形式（绝对时间无界时返回 —） */
export function formatAbsolute(anchorISO: string, offsetMin: number | null): string {
  if (offsetMin === null) return '—'
  const t = new Date(anchorISO)
  if (Number.isNaN(t.getTime())) return '—'
  t.setMinutes(t.getMinutes() + offsetMin)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** 完整日期时间（锚点展示用） */
export function formatFullDateTime(anchorISO: string): string {
  const t = new Date(anchorISO)
  if (Number.isNaN(t.getTime())) return '（无效时间）'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
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
