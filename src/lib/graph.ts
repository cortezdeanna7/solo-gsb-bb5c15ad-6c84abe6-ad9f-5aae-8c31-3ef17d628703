import type {
  AnalysisResult,
  BoundTrace,
  BoundTraceStep,
  Constraint,
  DiffEdge,
  Observation,
  TEvent,
  WindowInfo,
} from '../types'
import { edgeKey as edgeKeyOf } from '../types'
import { localToEpochMin } from './format'

/** 差分边稳定键，转出以便 App 高亮集合直接使用 */
export const edgeKey = edgeKeyOf

/**
 * 把一条“事件 A 比事件 B 早/晚 min..max 分钟”的约束转换为两条差分不等式。
 *
 * 约定有向边 u -> v，权重 w 表示  t_v - t_u <= w
 *
 * earlier:  min <= t_B - t_A <= max
 *   上界  t_B - t_A <= max   =>  A -> B, max
 *   下界  t_B - t_A >= min   =>  t_A - t_B <= -min  =>  B -> A, -min
 *
 * later:    min <= t_A - t_B <= max
 *   上界  t_A - t_B <= max   =>  B -> A, max
 *   下界  t_A - t_B >= min   =>  t_B - t_A <= -min  =>  A -> B, -min
 */
export function constraintToEdges(c: Constraint, index: (id: string) => number): DiffEdge[] {
  const a = index(c.aId)
  const b = index(c.bId)
  if (c.relation === 'earlier') {
    return [
      { u: a, v: b, w: c.max, origin: 'constraint', sourceId: c.id, bound: 'upper' },
      { u: b, v: a, w: -c.min, origin: 'constraint', sourceId: c.id, bound: 'lower' },
    ]
  }
  return [
    { u: b, v: a, w: c.max, origin: 'constraint', sourceId: c.id, bound: 'upper' },
    { u: a, v: b, w: -c.min, origin: 'constraint', sourceId: c.id, bound: 'lower' },
  ]
}

/**
 * 把一条绝对时间观测转换为相对“绝对时间零点”节点 clock 的两条差分不等式。
 *
 * 记零点节点 Z 的变量为 t_Z = 0（绝对时刻的纪元原点），事件 i 的变量 t_i
 * 直接以“距纪元的分钟数”为值，则观测 lo <= t_i <= hi 对应：
 *   上界  t_i - t_Z <= hi  =>  Z -> i, hi
 *   下界  t_Z - t_i <= -lo =>  i -> Z, -lo
 * 精确时刻（lo === hi，零宽区间）退化为一对等权夹逼边。
 *
 * 多条观测挂在同一个零点节点上，天然进入同一张差分图：观测之间以及观测与
 * 相对约束之间的冲突统一表现为含零点节点（或不含）的负环，无需逐锚点判断。
 */
export function observationToEdges(
  o: Observation,
  index: (id: string) => number,
  clockIdx: number,
): DiffEdge[] {
  const i = index(o.eventId)
  const lo = localToEpochMin(o.earliest)
  const hi = localToEpochMin(o.latest)
  if (lo === null || hi === null || lo > hi) return []
  return [
    { u: clockIdx, v: i, w: hi, origin: 'observation', sourceId: o.id, bound: 'upper' },
    { u: i, v: clockIdx, w: -lo, origin: 'observation', sourceId: o.id, bound: 'lower' },
  ]
}

export interface BuiltEdges {
  edges: DiffEdge[]
  indexOf: Map<string, number>
  /** 虚拟“绝对时间零点”节点下标；不存在任何有效观测时为 null（图中无该节点） */
  clockIdx: number | null
  /** 录入了至少一条有效观测的事件下标 */
  observedIdx: Set<number>
}

/**
 * 汇总全部启用的相对约束与绝对观测，构造统一差分图。
 * 边顺序确定：先按录入顺序的约束边（每条 2 条），再按录入顺序的观测边——
 * Bellman-Ford 的前驱选择因此确定，矛盾环提取与排程输出可复现。
 */
export function buildEdges(
  events: TEvent[],
  constraints: Constraint[],
  observations: Observation[] = [],
): BuiltEdges {
  const indexOf = new Map<string, number>()
  events.forEach((e, i) => indexOf.set(e.id, i))
  const idx = (id: string) => indexOf.get(id)!
  const edges: DiffEdge[] = []
  for (const c of constraints) {
    if (!c.enabled) continue
    // 跳过引用了已删除事件的约束
    if (!indexOf.has(c.aId) || !indexOf.has(c.bId)) continue
    edges.push(...constraintToEdges(c, idx))
  }

  const validObs = observations.filter(
    (o) =>
      o.enabled &&
      indexOf.has(o.eventId) &&
      (() => {
        const lo = localToEpochMin(o.earliest)
        const hi = localToEpochMin(o.latest)
        return lo !== null && hi !== null && lo <= hi
      })(),
  )
  let clockIdx: number | null = null
  const observedIdx = new Set<number>()
  if (validObs.length > 0) {
    clockIdx = events.length
    for (const o of validObs) {
      edges.push(...observationToEdges(o, idx, clockIdx))
      observedIdx.add(idx(o.eventId))
    }
  }
  return { edges, indexOf, clockIdx, observedIdx }
}

const INF = Number.POSITIVE_INFINITY

interface BFResult {
  dist: number[]
  predEdge: (DiffEdge | null)[]
  /** 第 n 轮仍被松弛的一条边（存在即说明有负环） */
  lastRelaxed: DiffEdge | null
}

/**
 * 通用 Bellman-Ford 松弛。
 * @param n      节点数
 * @param edges  边集
 * @param init   初始距离（长度为 n 的数组）
 */
function bellmanFord(n: number, edges: DiffEdge[], init: number[]): BFResult {
  const dist = init.slice()
  const predEdge: (DiffEdge | null)[] = new Array(n).fill(null)
  let lastRelaxed: DiffEdge | null = null

  for (let round = 0; round < n; round++) {
    lastRelaxed = null
    let changed = false
    for (const e of edges) {
      const nd = dist[e.u] + e.w
      if (nd < dist[e.v]) {
        dist[e.v] = nd
        predEdge[e.v] = e
        changed = true
        lastRelaxed = e
      }
    }
    if (!changed) break
  }
  return { dist, predEdge, lastRelaxed }
}

/**
 * 从最后被松弛的边出发，沿前驱指针回溯，抽取一条负环。
 * 返回的 edges[i] 从 nodes[i] 指向 nodes[(i+1) % len]。
 */
function extractCycle(lastEdge: DiffEdge, predEdge: (DiffEdge | null)[]): {
  nodes: number[]
  edges: DiffEdge[]
} | null {
  const n = predEdge.length
  // 回溯到环上：最后松弛边的终点一定可达某个负环；先走 n 步入环
  let cur = lastEdge.v
  for (let i = 0; i < n; i++) {
    const pe = predEdge[cur]
    if (!pe) return null
    cur = pe.u
  }

  const cycleNodes: number[] = []
  const cycleEdges: DiffEdge[] = []
  const seenAt = new Map<number, number>()
  const start = cur
  // 从环上某点沿前驱方向收集（方向是反向环绕），直到再次遇到该点
  let guard = 0
  while (!seenAt.has(cur) && guard <= n) {
    seenAt.set(cur, cycleNodes.length)
    cycleNodes.push(cur)
    const pe = predEdge[cur]
    if (!pe) return null
    cycleEdges.push(pe)
    cur = pe.u
    guard++
  }
  if (cur !== start) {
    // 回溯路径中先经过了一段“环外尾巴”，裁掉尾巴
    const cut = seenAt.get(cur)!
    cycleNodes.splice(0, cut)
    cycleEdges.splice(0, cut)
  }
  // 当前 cycleEdges[i] 进入 cycleNodes[i]（来自 cycleNodes[i+1]，反向环绕）。
  // 反转节点与边的顺序，再把边数组循环左移一位，
  // 使最终 edges[i] 从 nodes[i] 指向 nodes[(i+1) % len]。
  cycleNodes.reverse()
  cycleEdges.reverse()
  if (cycleEdges.length > 1) {
    cycleEdges.push(cycleEdges.shift()!)
  }
  return { nodes: cycleNodes, edges: cycleEdges }
}

/** 从单个源点求最短路距离；不可达为 +∞ */
function shortestFrom(source: number, n: number, edges: DiffEdge[]): number[] {
  const init = new Array(n).fill(INF)
  init[source] = 0
  const { dist } = bellmanFord(n, edges, init)
  return dist
}

/**
 * 超级源点 Bellman-Ford 检测负环：等价于加入一个指向所有节点、权重 0 的超级源点，
 * 即所有节点初始距离为 0（差分约束经典做法）。找到时抽取一条负环。
 */
export function findNegativeCycle(
  n: number,
  edges: DiffEdge[],
): { nodes: number[]; edges: DiffEdge[]; totalWeight: number; involvesObservation: boolean } | null {
  if (n === 0) return null
  const { predEdge, lastRelaxed } = bellmanFord(n, edges, new Array(n).fill(0))
  if (!lastRelaxed) return null
  const cyc = extractCycle(lastRelaxed, predEdge)
  if (!cyc) return null
  return {
    nodes: cyc.nodes,
    edges: cyc.edges,
    totalWeight: cyc.edges.reduce((s, e) => s + e.w, 0),
    involvesObservation: cyc.edges.some((e) => e.origin === 'observation'),
  }
}

/**
 * 超级源点 Bellman-Ford 求一组可行势：返回值 h 满足对每条边 h[v] − h[u] ≤ w
 * （全部节点初始距离为 0，等价于引入指向所有节点、权重 0 的超级源点）。
 * 系统可满足时返回势数组（确定性：结果只取决于边集与边顺序），存在负环时返回 null。
 */
export function feasiblePotentials(n: number, edges: DiffEdge[]): number[] | null {
  if (n === 0) return []
  const { dist, lastRelaxed } = bellmanFord(n, edges, new Array(n).fill(0))
  return lastRelaxed ? null : dist
}

/**
 * 对当前全部启用的相对约束与绝对观测做完整分析：
 * 1) 在同一张差分图（含虚拟绝对时间零点）上以超级源点 Bellman-Ford 检测负环；
 * 2) 有负环时抽取一条矛盾环（观测之间 / 观测与相对约束的冲突都在该环上）；
 * 3) 可满足时，以时间零点为源求各事件绝对时刻的最早/最晚时间窗；
 *    未与任何观测连通（正/反向均不可达）的事件标记为“无法定时”。
 */
export function analyze(
  events: TEvent[],
  constraints: Constraint[],
  observations: Observation[] = [],
): AnalysisResult {
  const nEvents = events.length
  const { edges, clockIdx, observedIdx } = buildEdges(events, constraints, observations)
  const windows = new Map<number, WindowInfo>()
  const n = clockIdx === null ? nEvents : clockIdx + 1

  if (nEvents === 0) {
    return { satisfiable: true, windows, clockIdx }
  }

  const cyc = findNegativeCycle(n, edges)
  if (cyc) {
    return {
      satisfiable: false,
      cycle: cyc,
      windows,
      clockIdx,
    }
  }

  if (clockIdx === null) {
    // 无任何有效观测：系统一致但没有绝对时间基准，全部事件无法定时
    for (let i = 0; i < nEvents; i++) {
      windows.set(i, { status: 'disconnected', earliestMin: null, latestMin: null, observed: false })
    }
    return { satisfiable: true, windows, clockIdx }
  }

  // 最晚时刻：t_i 的最小上界（时间零点正向最短路）
  const upper = shortestFrom(clockIdx, n, edges)
  // 最早时刻：−t_i 的最小上界取负（反向图最短路）
  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const back = shortestFrom(clockIdx, n, reversed)

  for (let i = 0; i < nEvents; i++) {
    const hasUpper = Number.isFinite(upper[i])
    const hasLower = Number.isFinite(back[i])
    const earliest = hasLower ? -back[i] : null
    const latest = hasUpper ? upper[i] : null

    let status: WindowInfo['status']
    if (hasLower && hasUpper) status = 'bounded'
    else if (hasLower || hasUpper) status = 'oneSided'
    else status = 'disconnected'

    windows.set(i, {
      status,
      earliestMin: earliest,
      latestMin: latest,
      observed: observedIdx.has(i),
    })
  }

  return { satisfiable: true, cycle: undefined, windows, clockIdx }
}

/**
 * 沿前驱指针从 target 回溯到 source，返回从 source 出发按行走顺序排列的边。
 * 系统可满足时前驱子图无环，必然在 n 步内到达 source；guard 仅为防御。
 */
function reconstructPath(
  predEdge: (DiffEdge | null)[],
  source: number,
  target: number,
): DiffEdge[] | null {
  const path: DiffEdge[] = []
  let cur = target
  let guard = 0
  while (cur !== source) {
    const pe = predEdge[cur]
    if (!pe) return null
    path.push(pe)
    cur = pe.u
    if (++guard > predEdge.length) return null
  }
  path.reverse()
  return path
}

/**
 * 边界依据追溯：还原“从绝对时间零点推出某事件最早/最晚边界”的紧约束链。
 *
 * 前提：差分系统可满足且至少存在一条有效观测（调用方保证，否则最短路无意义）。
 * - 最晚边界：正向图上时间零点到目标的最短路，路径边即依次采用的原始边
 *   （观测上界边或约束边），累计值为绝对时刻上界（纪元分钟数）；
 * - 最早边界：反向图上的最短路给出 −t_target 的最小上界；
 *   反向路径上的每条边都还原为原始边（方向相反、权重与上/下界侧不变），
 *   累计值取负得到绝对时刻下界。
 *
 * 链上可同时出现观测边与约束边；该侧无界 / 事件不可达 / 无观测时返回 null。
 */
export function traceBound(
  events: TEvent[],
  constraints: Constraint[],
  observations: Observation[],
  eventIdx: number,
  kind: 'earliest' | 'latest',
): BoundTrace | null {
  const nEvents = events.length
  if (eventIdx < 0 || eventIdx >= nEvents) return null

  const { edges, clockIdx } = buildEdges(events, constraints, observations)
  if (clockIdx === null) return null
  const n = clockIdx + 1

  const init = new Array(n).fill(INF)
  init[clockIdx] = 0

  if (kind === 'latest') {
    const { dist, predEdge } = bellmanFord(n, edges, init)
    if (!Number.isFinite(dist[eventIdx])) return null
    const chain = reconstructPath(predEdge, clockIdx, eventIdx)
    if (!chain) return null
    let cum = 0
    const steps: BoundTraceStep[] = chain.map((e) => {
      cum += e.w
      return { edge: e, from: e.u, to: e.v, cumulative: cum }
    })
    return { eventIdx, clockIdx, kind, offset: dist[eventIdx], steps }
  }

  // 最早边界：在反向图上求最短路，再把反向路径逐步还原为原始边
  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const { dist, predEdge } = bellmanFord(n, reversed, init)
  if (!Number.isFinite(dist[eventIdx])) return null
  const chain = reconstructPath(predEdge, clockIdx, eventIdx)
  if (!chain) return null
  let cum = 0
  const steps: BoundTraceStep[] = chain.map((re) => {
    cum += re.w
    // re 是原始边 (u -> v, w) 的反向拷贝；本步从 v 走到 u，展示时还原为原始边
    const orig: DiffEdge = { ...re, u: re.v, v: re.u }
    return { edge: orig, from: re.u, to: re.v, cumulative: -cum }
  })
  return { eventIdx, clockIdx, kind, offset: -dist[eventIdx], steps }
}
