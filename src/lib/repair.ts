import type {
  Constraint,
  Observation,
  RepairDisableItem,
  RepairPlan,
  RepairSearchResult,
  TEvent,
} from '../types'
import { analyze, buildEdges, findNegativeCycle } from './graph'

/** 累计搜索状态数上限：超过即停止，并标记结果可能不完备 */
export const DEFAULT_STATE_LIMIT = 2000

/** 并列最优方案最多展示数量 */
export const MAX_PLANS = 5

/**
 * 可被“停用”的修复候选：启用中的相对约束或绝对时间观测。
 * index 为候选序列下标（约束按录入顺序在前、观测按录入顺序在后），
 * 使方案排序稳定且与界面录入顺序一致。
 */
interface Candidate {
  index: number
  origin: 'constraint' | 'observation'
  sourceId: string
}

type State = number[] // 已停用候选的下标，升序

/** 按下标（录入顺序）字典序比较两个停用集合 */
function lexCmp(a: State, b: State): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * 最小修复建议：当统一差分图存在负环时，搜索“停用条目数量最少”的可满足方案。
 *
 * 冲突既可能只在相对约束之间，也可能在观测之间、或观测与相对约束之间，
 * 因此修复候选同时包含启用的约束与观测；负环上的来源无论种类都会被纳入分支，
 * 保证一条矛盾链上的观测与原约束被同时对待，而不是逐锚点独立判断。
 *
 * 搜索以每次 Bellman-Ford 发现的负环为分支依据（branch on one negative cycle）：
 * 设当前已停用集合 D，差分图中仍有负环 C，则任何可满足的停用集合都必须再停掉
 * C 上的至少一个来源。因此只需对 C 上的候选逐一分支，既保证完备性，又避免
 * 枚举无关条目。按停用数 0,1,2,… 逐层 BFS，第一层中出现的可行状态即最优
 * （停用数最少）；同层全部状态都会被考察，以收集并列最优方案。
 *
 * 累计访问状态数超过 stateLimit（默认 2000）时停止，结果标记 truncated，
 * 提示结果可能不完备。
 */
export function findMinimalRepairs(
  events: TEvent[],
  constraints: Constraint[],
  observations: Observation[],
  opts: { stateLimit?: number } = {},
): RepairSearchResult {
  const stateLimit = opts.stateLimit ?? DEFAULT_STATE_LIMIT

  // 候选序列：先约束（录入顺序）、后观测（录入顺序），仅含启用且引用事件存在者，
  // 与 buildEdges 实际采用的边来源保持一致。
  const eventIds = new Set(events.map((e) => e.id))
  const candidates: Candidate[] = []
  for (const c of constraints) {
    if (c.enabled && eventIds.has(c.aId) && eventIds.has(c.bId)) {
      candidates.push({ index: candidates.length, origin: 'constraint', sourceId: c.id })
    }
  }
  for (const o of observations) {
    if (o.enabled && eventIds.has(o.eventId)) {
      candidates.push({ index: candidates.length, origin: 'observation', sourceId: o.id })
    }
  }

  const { edges: allEdges } = buildEdges(events, constraints, observations)
  const candidateIndex = new Map<string, number>()
  for (const cand of candidates) candidateIndex.set(`${cand.origin}:${cand.sourceId}`, cand.index)

  const activeEdges = (state: State) => {
    if (state.length === 0) return allEdges
    const off = new Set(state.map((i) => `${candidates[i].origin}:${candidates[i].sourceId}`))
    return allEdges.filter((e) => !off.has(`${e.origin}:${e.sourceId}`))
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
      const cyc = findNegativeCycle(allEdges.length > 0 ? nodeCount(events, edges) : events.length, edges)
      if (!cyc) {
        feasible.push(state)
        continue
      }

      // 以该负环上的不同来源（候选下标升序）为分支
      const onCycle = new Set<number>()
      for (const e of cyc.edges) {
        const ci = candidateIndex.get(`${e.origin}:${e.sourceId}`)
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
        plans: feasible
          .slice(0, MAX_PLANS)
          .map((s) => toPlan(s, candidates, events, constraints, observations)),
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

  // 理论上不可达：停用全部候选后图中无边，必然可满足
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

/** 有效边集中出现的最大节点下标 + 1（决定是否含虚拟时间零点节点） */
function nodeCount(events: TEvent[], edges: ReturnType<typeof buildEdges>['edges']): number {
  let maxNode = events.length - 1
  for (const e of edges) {
    if (e.u > maxNode) maxNode = e.u
    if (e.v > maxNode) maxNode = e.v
  }
  return maxNode + 1
}

/** 由停用下标构造可展示的修复方案（停用条目 + 修复后时间窗） */
function toPlan(
  state: State,
  candidates: Candidate[],
  events: TEvent[],
  constraints: Constraint[],
  observations: Observation[],
): RepairPlan {
  const off = new Set(state.map((i) => `${candidates[i].origin}:${candidates[i].sourceId}`))
  const simulatedConstraints = constraints.map((c) =>
    off.has(`constraint:${c.id}`) ? { ...c, enabled: false } : c,
  )
  const simulatedObservations = observations.map((o) =>
    off.has(`observation:${o.id}`) ? { ...o, enabled: false } : o,
  )
  // 复用 analyze 得到修复后的时间窗，保证与主界面完全一致的口径
  const { windows } = analyze(events, simulatedConstraints, simulatedObservations)
  const disableItems: RepairDisableItem[] = state
    .map((i) => ({ origin: candidates[i].origin, sourceId: candidates[i].sourceId }))
    .sort((a, b) => {
      // 展示排序与候选录入顺序一致
      const ia = candidates.findIndex((c) => c.origin === a.origin && c.sourceId === a.sourceId)
      const ib = candidates.findIndex((c) => c.origin === b.origin && c.sourceId === b.sourceId)
      return ia - ib
    })
  return { disableItems, windows }
}
