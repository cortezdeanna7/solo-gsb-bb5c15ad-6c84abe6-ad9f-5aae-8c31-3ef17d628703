import type {
  AnalysisResult,
  BoundTrace,
  BoundTraceStep,
  Constraint,
  DiffEdge,
  TEvent,
  WindowInfo,
} from '../types'

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
      { u: a, v: b, w: c.max, constraintId: c.id, bound: 'upper' },
      { u: b, v: a, w: -c.min, constraintId: c.id, bound: 'lower' },
    ]
  }
  return [
    { u: b, v: a, w: c.max, constraintId: c.id, bound: 'upper' },
    { u: a, v: b, w: -c.min, constraintId: c.id, bound: 'lower' },
  ]
}

export function buildEdges(
  events: TEvent[],
  constraints: Constraint[],
): { edges: DiffEdge[]; indexOf: Map<string, number> } {
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
  return { edges, indexOf }
}

/**
 * Bellman-Ford：从单一源点出发求最长短路界 dist[v] = t_v - t_s 的最小上界。
 * 不直接使用——下面用带“超级源点”的统一写法做负环检测，
 * 并用“把指定源点置 0、其余置 +∞”的写法求可达距离。
 */

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
  let start = cur
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
): { nodes: number[]; edges: DiffEdge[]; totalWeight: number } | null {
  if (n === 0) return null
  const { predEdge, lastRelaxed } = bellmanFord(n, edges, new Array(n).fill(0))
  if (!lastRelaxed) return null
  const cyc = extractCycle(lastRelaxed, predEdge)
  if (!cyc) return null
  return { nodes: cyc.nodes, edges: cyc.edges, totalWeight: cyc.edges.reduce((s, e) => s + e.w, 0) }
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
 * 对当前全部启用的约束做完整分析：
 * 1) 超级源点 Bellman-Ford 检测差分系统是否可满足（有无负环）；
 * 2) 有负环时抽取一条矛盾环；
 * 3) 可满足时，以锚点为源求各事件相对锚点的最早/最晚时间窗。
 */
export function analyze(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
): AnalysisResult {
  const n = events.length
  const { edges } = buildEdges(events, constraints)
  const windows = new Map<number, WindowInfo>()

  if (n === 0) {
    return { satisfiable: true, windows }
  }

  const cyc = findNegativeCycle(n, edges)
  if (cyc) {
    return {
      satisfiable: false,
      cycle: cyc,
      windows,
    }
  }

  // —— 可满足：计算时间窗
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  if (anchorIdx < 0) {
    // 未指定锚点：系统一致但无法给出绝对时间窗
    for (let i = 0; i < n; i++) {
      windows.set(i, { status: 'disconnected', earliestOffset: null, latestOffset: null })
    }
    return { satisfiable: true, windows }
  }

  // 最晚偏移：t_i - t_anchor 的最小上界（正向最短路）
  const upper = shortestFrom(anchorIdx, n, edges)
  // 最早偏移：t_anchor - t_i 的最小上界取负（反向图最短路）
  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const back = shortestFrom(anchorIdx, n, reversed)

  for (let i = 0; i < n; i++) {
    if (i === anchorIdx) {
      windows.set(i, { status: 'anchor', earliestOffset: 0, latestOffset: 0 })
      continue
    }
    const hasUpper = Number.isFinite(upper[i])
    const hasLower = Number.isFinite(back[i])
    const earliest = hasLower ? -back[i] : null
    const latest = hasUpper ? upper[i] : null

    let status: WindowInfo['status']
    if (hasLower && hasUpper) status = 'bounded'
    else if (hasLower || hasUpper) status = 'oneSided'
    else status = 'disconnected'

    windows.set(i, { status, earliestOffset: earliest, latestOffset: latest })
  }

  return { satisfiable: true, cycle: undefined, windows }
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
 * 边界依据追溯：还原“从锚点推出某事件最早/最晚边界”的紧约束链。
 *
 * 前提：差分系统可满足（调用方保证，否则最短路无意义）。
 * - 最晚边界：正向图上锚点到目标的最短路，路径边即依次采用的原始约束边，
 *   累计偏移 = 路径权重前缀和（t_to − t_anchor 的上界）；
 * - 最早边界：反向图上的最短路给出 t_anchor − t_target 的最小上界；
 *   反向路径上的每条边都还原为原始约束边（方向相反、权重与上/下界侧不变），
 *   累计偏移 = 路径权重前缀和取负（t_to − t_anchor 的下界）。
 *
 * 锚点自身返回零步证明（steps 为空）；该侧无界 / 事件不可达 / 无锚点时返回 null。
 */
export function traceBound(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
  eventIdx: number,
  kind: 'earliest' | 'latest',
): BoundTrace | null {
  const n = events.length
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  if (anchorIdx < 0 || eventIdx < 0 || eventIdx >= n) return null

  // 锚点：边界即锚点自身，零步证明
  if (eventIdx === anchorIdx) {
    return { eventIdx, kind, offset: 0, steps: [] }
  }

  const { edges } = buildEdges(events, constraints)
  const init = new Array(n).fill(INF)
  init[anchorIdx] = 0

  if (kind === 'latest') {
    const { dist, predEdge } = bellmanFord(n, edges, init)
    if (!Number.isFinite(dist[eventIdx])) return null
    const chain = reconstructPath(predEdge, anchorIdx, eventIdx)
    if (!chain) return null
    let cum = 0
    const steps: BoundTraceStep[] = chain.map((e) => {
      cum += e.w
      return { edge: e, from: e.u, to: e.v, cumulative: cum }
    })
    return { eventIdx, kind, offset: dist[eventIdx], steps }
  }

  // 最早边界：在反向图上求最短路，再把反向路径逐步还原为原始约束边
  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const { dist, predEdge } = bellmanFord(n, reversed, init)
  if (!Number.isFinite(dist[eventIdx])) return null
  const chain = reconstructPath(predEdge, anchorIdx, eventIdx)
  if (!chain) return null
  let cum = 0
  const steps: BoundTraceStep[] = chain.map((re) => {
    cum += re.w
    // re 是原始边 (u -> v, w) 的反向拷贝；本步从 v 走到 u，展示时还原为原始边
    const orig: DiffEdge = { ...re, u: re.v, v: re.u }
    return { edge: orig, from: re.u, to: re.v, cumulative: -cum }
  })
  return { eventIdx, kind, offset: -dist[eventIdx], steps }
}
