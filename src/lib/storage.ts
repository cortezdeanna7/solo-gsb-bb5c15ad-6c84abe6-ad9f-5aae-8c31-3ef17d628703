import type { AppState, Observation } from '../types'
import { uid } from './samples'

const STORAGE_KEY = 'temporal-constraint-checker:v1'

/**
 * 规范化 / 迁移旧版存档：
 * - observations 缺失（旧版单锚点存档）时，把 anchorId + anchorTime 迁移为
 *   一条零宽（精确）绝对时间观测；旧 anchorId/anchorTime 字段随后不再使用；
 * - desiredTimes / desiredPriorities 缺失时补空表，非法层级值剔除。
 */
export function migrateState(parsed: any): AppState | null {
  if (!parsed || !Array.isArray(parsed.events) || !Array.isArray(parsed.constraints)) return null

  if (!parsed.desiredTimes || typeof parsed.desiredTimes !== 'object') {
    parsed.desiredTimes = {}
  }
  if (!parsed.desiredPriorities || typeof parsed.desiredPriorities !== 'object') {
    parsed.desiredPriorities = {}
  } else {
    for (const [id, lv] of Object.entries(parsed.desiredPriorities)) {
      if (lv !== 'high' && lv !== 'medium' && lv !== 'low') {
        delete parsed.desiredPriorities[id]
      }
    }
  }

  if (!Array.isArray(parsed.observations)) {
    // 旧版存档：单锚点 → 一条精确观测（锚点事件仍存在时才迁移）
    const observations: Observation[] = []
    const anchorId = typeof parsed.anchorId === 'string' ? parsed.anchorId : null
    const anchorTime = typeof parsed.anchorTime === 'string' ? parsed.anchorTime : ''
    if (
      anchorId &&
      anchorTime &&
      (parsed.events as any[]).some((e: any) => e && e.id === anchorId)
    ) {
      observations.push({
        id: uid('obs'),
        eventId: anchorId,
        earliest: anchorTime,
        latest: anchorTime,
        enabled: true,
      })
    }
    parsed.observations = observations
  } else {
    // 仅保留结构合法的观测（引用事件存在、时间字段为字符串、启用标志布尔化）。
    // 时间区间暂时左右颠倒（编辑过程中的中间态）的观测也保留：图构建时会忽略它，
    // 界面给出警示，用户可继续修改，避免刷新后输入中的数据丢失。
    const eventIds = new Set((parsed.events as any[]).map((e: any) => e?.id))
    parsed.observations = (parsed.observations as any[]).filter((o) => {
      if (!o || typeof o.id !== 'string' || typeof o.eventId !== 'string') return false
      if (!eventIds.has(o.eventId)) return false
      if (typeof o.earliest !== 'string' || typeof o.latest !== 'string') return false
      return true
    }).map((o) => ({
      id: o.id,
      eventId: o.eventId,
      earliest: o.earliest,
      latest: o.latest,
      enabled: o.enabled !== false,
    }))
  }

  delete parsed.anchorId
  delete parsed.anchorTime
  return parsed as AppState
}

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return migrateState(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式 / 配额不足时静默失败，不影响使用
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
