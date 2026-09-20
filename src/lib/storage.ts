import type { AppState } from '../types'

const STORAGE_KEY = 'temporal-constraint-checker:v1'

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AppState
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.constraints)) return null
    // 旧版本存档没有期望时刻字段：规范化为空表
    if (!parsed.desiredTimes || typeof parsed.desiredTimes !== 'object') {
      parsed.desiredTimes = {}
    }
    // 旧版本存档没有优先级层级字段：规范化为空表（缺省按「中」参与排程），
    // 并过滤手工篡改等原因产生的非法层级值
    if (!parsed.desiredPriorities || typeof parsed.desiredPriorities !== 'object') {
      parsed.desiredPriorities = {}
    } else {
      for (const [id, lv] of Object.entries(parsed.desiredPriorities)) {
        if (lv !== 'high' && lv !== 'medium' && lv !== 'low') {
          delete parsed.desiredPriorities[id]
        }
      }
    }
    return parsed
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
