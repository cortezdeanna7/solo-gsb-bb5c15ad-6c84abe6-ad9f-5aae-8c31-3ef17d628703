import type { Constraint, RepairPlan, RepairSearchResult, TEvent } from '../types'
import { analyze, buildEdges, findNegativeCycle } from './graph'

/** 累计搜索状态数上限：超过即停止，并标记结果可能不完备 */
export const DEFAULT_STATE_LIMIT = 2000

/** 并列最优方案最多展示数量 */
export const MAX_PLANS = 5

type State = number[] // 已停用约束在候选序列（即约束录入顺序）中的下标，升序

/** 按录入顺序（下标字典序）比较两个停用集合 */
function lexCmp(a: State, b: State): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * 最小修复建议：当约束系统存在负环时，搜索“停用约束数量最少”的可满足方案。
 *
 * 搜索以每次 Bellman-Ford 发现的负环为分支依据（branch on one negative cycle）：
 * 设当前已停用集合 D，差分图中仍有负环 C，则任何可满足的停用集合都必须再停掉
 * C 上的至少一条约束。因此只需对 C 上的约束逐一分支，既保证完备性，又避免
 * 枚举无关约束。按停用数 0,1,2,… 逐层 BFS，第一层中出现的可行状态即最优
 * （停用数最少）；同层全部状态都会被考察，以收集并列最优方案。
 *
 * 累计访问状态数超过 stateLimit（默认 2000）时停止，结果标记 truncated，
 * 提示结果可能不完备。
 */
export function findMinimalRepairs(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
  opts: { stateLimit?: number } = {},
): RepairSearchResult {
  const stateLimit = opts.stateLimit ?? DEFAULT_STATE_LIMIT

  // 候选约束 = 当前启用且引用事件均存在的约束（buildEdges 实际采用的那些），
  // 保持约束录入顺序，使方案排序稳定。
  const eventIds = new Set(events.map((e) => e.id))
  const candidates = constraints.filter(
    (c) => c.enabled && eventIds.has(c.aId) && eventIds.has(c.bId),
  )

  const { edges: allEdges } = buildEdges(events, constraints)
  const candidateIndex = new Map(candidates.map((c, i) => [c.id, i]))
  const activeEdges = (state: State) => {
    if (state.length === 0) return allEdges
    const off = new Set(state.map((i) => candidates[i].id))
    return allEdges.filter((e) => !off.has(e.constraintId))
  }

  let statesVisited = 0
  const keyOf = (state: State) => state.join('.')
  const visited = new Set<string>([''])

  let level: State[] = [[]]
  let truncated = false

  while (level.length > 0) {
    const feasible: State[] = []
    const next: State[] = []

    for (const state of level) {
      if (statesVisited >= stateLimit) {
        truncated = true
        break
      }
      statesVisited++
      const edges = activeEdges(state)
      const cyc = findNegativeCycle(events.length, edges)
      if (!cyc) {
        feasible.push(state)
        continue
      }

      // 以该负环上的不同约束（候选下标升序）为分支
      const onCycle = new Set<number>()
      for (const e of cyc.edges) {
        const ci = candidateIndex.get(e.constraintId)
        if (ci !== undefined && !state.includes(ci)) onCycle.add(ci)
      }
      const branchIdx = [...onCycle].sort((a, b) => a - b)
      for (const ci of branchIdx) {
        const child = [...state, ci].sort((a, b) => a - b)
        const key = keyOf(child)
        if (!visited.has(key)) {
          visited.add(key)
          next.push(child)
        }
      }
    }

    if (feasible.length > 0) {
      // 按层 BFS：第一次出现可行状态的层，停用数即最小（已被证明）。
      const disableCount = feasible[0].length
      // 根状态即可行：系统本身无矛盾，无需修复
      if (disableCount === 0) {
        return {
          found: true,
          plans: [],
          totalPlans: 0,
          disableCount: 0,
          truncated: false,
          optimumProven: true,
          statesVisited,
          stateLimit,
        }
      }
      // 若中途因状态数上限截断，本层可能还有未访问的并列方案 —— 明确标记。
      feasible.sort(lexCmp)
      return {
        found: true,
        plans: feasible.slice(0, MAX_PLANS).map((s) => toPlan(s, candidates, events, constraints, anchorId)),
        totalPlans: feasible.length,
        disableCount,
        truncated,
        optimumProven: true,
        statesVisited,
        stateLimit,
      }
    }

    if (truncated) {
      // 已达到状态数上限，且尚未在任何层找到可行方案
      return {
        found: false,
        plans: [],
        totalPlans: 0,
        disableCount: -1,
        truncated: true,
        optimumProven: false,
        statesVisited,
        stateLimit,
      }
    }

    level = next
  }

  // 理论上不可达：停用全部候选约束后图中无边，必然可满足
  return {
    found: false,
    plans: [],
    totalPlans: 0,
    disableCount: -1,
    truncated: false,
    optimumProven: false,
    statesVisited,
    stateLimit,
  }
}

/** 由停用下标构造可展示的修复方案（停用约束 + 修复后时间窗） */
function toPlan(
  state: State,
  candidates: Constraint[],
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
): RepairPlan {
  const offIds = new Set(state.map((i) => candidates[i].id))
  const simulated = constraints.map((c) =>
    offIds.has(c.id) ? { ...c, enabled: false } : c,
  )
  // 复用 analyze 得到修复后的时间窗，保证与主界面完全一致的口径
  const { windows } = analyze(events, simulated, anchorId)
  return {
    disableConstraintIds: state.map((i) => candidates[i].id),
    windows,
  }
}
