import type {
  Constraint,
  DiffEdge,
  LayerResult,
  Observation,
  PriorityLevel,
  ScheduleEntry,
  ScheduleResult,
  TEvent,
} from '../types'
import { analyze, buildEdges, feasiblePotentials } from './graph'
import { localToEpochMin } from './format'

/** 钉住期望事件时使用的合成来源 id（仅内部标识，不进入展示） */
const PIN_ID = '__desired_pin__'

/** 字典序优化的层级顺序：先高、再中、后低 */
const LEVEL_ORDER: PriorityLevel[] = ['high', 'medium', 'low']

/** 未显式选择层级时的默认优先级（旧版存档没有层级字段，也按此兼容） */
export const DEFAULT_PRIORITY: PriorityLevel = 'medium'

/**
 * 分层最小偏差排程（高 → 中 → 低 字典序最小化）。
 *
 * 前提：统一差分系统（相对约束 + 全部绝对观测，含虚拟时间零点节点 Z）可满足，
 * 且至少存在一条有效观测（否则没有任何绝对时间基准，返回 null）。
 * 对每个「已填写有效期望绝对时刻且与观测连通」的事件 i，记其期望绝对时刻
 * （纪元分钟数）为 d_i、优先级层级为 L(i)（未选择时按「中」）。按层级
 * 高 → 中 → 低 依次求解：
 *
 * 1. 求当前层的最小非负整数容差 D_L，使**累计差分系统**（原始启用边 + 所有更高层
 *    已固定的 ±D 钉住约束）与本层全部钉住约束
 *
 *        d_i − D_L ≤ t_i − t_Z ≤ d_i + D_L
 *
 *    同时可满足；每个候选 D 的可行性都通过对**整体**差分图做负环检测来判定
 *    （整体可满足性搜索），而不是把各事件独立夹到各自的时间窗——后者忽略事件间
 *    耦合（例如 t_Y = t_X + 5 时，X、Y 各自的窗口都可能包含期望值，但二者不能
 *    同时取到），会得出偏小的伪最优；
 * 2. 把本层 ±D_L 的钉住边**永久并入累计边集**（固定其最优容差），再求下一层。
 *    低层优化在任何候选下都受高层钉住约束限制，绝不可能牺牲高层已达成的容差；
 *    尚未求到的更低层此时不参与钉住（自由），符合字典序语义。
 *
 * 不使用加权和、也不分层各自排程后拼接：所有可行性判定与最终输出都产生自同一个
 * 累计差分图，因此最终排程同时满足全部启用约束、全部观测与各层最优容差。
 *
 * 全部层级求完后，取累计钉住图上的一组可行势作为输出排程（取绝对时刻值本身，
 * t_Z 已固定为 0）。边集与边顺序确定时 Bellman-Ford 结果确定，因此输出确定。
 * 由于每层 D_L 最小（D_L − 1 在更少约束下已不可行），最终排程中每层必然
 * 有事件达到 ±D_L。
 *
 * 未与任何观测连通的事件不参与搜索，在结果中标记为 unscheduled（未定时）；
 * 其上填写的期望时刻与层级被忽略（desiredIgnored = true）。
 */
export function computeMinDeviationSchedule(
  events: TEvent[],
  constraints: Constraint[],
  observations: Observation[],
  desiredTimes: Record<string, string>,
  desiredPriorities: Record<string, PriorityLevel>,
): ScheduleResult | null {
  const nEvents = events.length
  if (nEvents === 0) return null

  const base = analyze(events, constraints, observations)
  if (!base.satisfiable || base.clockIdx === null) return null
  const clockIdx = base.clockIdx
  const n = clockIdx + 1

  const { edges } = buildEdges(events, constraints, observations)
  const idxOf = new Map(events.map((e, i) => [e.id, i]))

  // 期望时刻 → 纪元分钟数（无效输入忽略）
  const desired = new Map<number, number>()
  for (const [id, iso] of Object.entries(desiredTimes)) {
    const i = idxOf.get(id)
    if (i === undefined || !iso) continue
    const t = localToEpochMin(iso)
    if (t !== null) desired.set(i, t)
  }

  const connected = (i: number) => {
    const w = base.windows.get(i)
    return !!w && w.status !== 'disconnected'
  }

  const priorityOf = (i: number): PriorityLevel =>
    desiredPriorities[events[i].id] ?? DEFAULT_PRIORITY

  // 参与整体搜索的期望事件：期望有效且与观测连通（按事件下标升序，保证确定性）
  const targets = [...desired.keys()].filter(connected).sort((a, b) => a - b)
  if (targets.length === 0) return null

  // 按层级分组（组内保持事件下标升序）
  const byLevel = new Map<PriorityLevel, number[]>()
  for (const i of targets) {
    const lv = priorityOf(i)
    const g = byLevel.get(lv)
    if (g) g.push(i)
    else byLevel.set(lv, [i])
  }

  /** 一组事件在给定 D 下的钉住边（对时间零点双向夹逼） */
  const pinEdges = (group: number[], D: number): DiffEdge[] => {
    const es: DiffEdge[] = []
    for (const i of group) {
      const d = desired.get(i)!
      es.push(
        { u: clockIdx, v: i, w: d + D, origin: 'observation', sourceId: PIN_ID, bound: 'upper' },
        { u: i, v: clockIdx, w: D - d, origin: 'observation', sourceId: PIN_ID, bound: 'lower' },
      )
    }
    return es
  }

  // —— 字典序主循环：累计边集从原始边出发，逐层并入已固定的钉住边 ——
  const accEdges = edges.slice()
  const layers: LayerResult[] = []
  for (const level of LEVEL_ORDER) {
    const group = byLevel.get(level) ?? []
    if (group.length === 0) {
      layers.push({ level, count: 0, D: null, tightEventIdx: [], maxDeviation: null })
      continue
    }

    // 上界：累计系统的可行势 t* 满足全部已固定约束，D_ub = max |t*_i − d_i| 必然可行。
    // 不变式：accEdges 可满足（原始系统可满足；每层并入的钉住边在并入前已验证可行）。
    const pot = feasiblePotentials(n, accEdges)
    if (!pot) return null // 防御：不变式保证可满足，理论不可达
    let hi = 0
    for (const i of group) {
      hi = Math.max(hi, Math.abs(pot[i] - pot[clockIdx] - desired.get(i)!))
    }

    // 二分本层最小可行非负整数 D；不变式：lo 不可行（−1 为哨兵），hi 可行
    let lo = -1
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (feasiblePotentials(n, [...accEdges, ...pinEdges(group, mid)]) !== null) hi = mid
      else lo = mid
    }
    const D = hi

    // 固定本层最优容差：钉住边并入累计边集，约束后续所有更低层
    accEdges.push(...pinEdges(group, D))
    layers.push({ level, count: group.length, D, tightEventIdx: [], maxDeviation: null })
  }

  // 输出排程：累计钉住图上的一组可行势；t_Z 固定为 0，势值即绝对时刻
  const h = feasiblePotentials(n, accEdges)!
  const actualOf = (i: number) => h[i] - h[clockIdx]

  const entries: ScheduleEntry[] = events.map((_, i): ScheduleEntry => {
    const d = desired.get(i) ?? null
    const priority = d !== null ? priorityOf(i) : null
    if (!connected(i)) {
      return {
        eventIdx: i,
        status: 'unscheduled',
        actualMin: null,
        desiredMin: d,
        deviation: null,
        desiredIgnored: d !== null,
        priority,
      }
    }
    const actual = actualOf(i)
    return {
      eventIdx: i,
      status: 'scheduled',
      actualMin: actual,
      desiredMin: d,
      deviation: d !== null ? actual - d : null,
      desiredIgnored: false,
      priority,
    }
  })

  // 由最终排程回填各层的最大偏差与达到 ±D 的事件
  for (const layer of layers) {
    if (layer.count === 0) continue
    const tight: number[] = []
    let maxDeviation = 0
    for (const i of byLevel.get(layer.level)!) {
      const dev = Math.abs(entries[i].deviation!)
      if (dev > maxDeviation) maxDeviation = dev
      if (Math.abs(dev - layer.D!) < 1e-9) tight.push(i)
    }
    layer.tightEventIdx = tight
    layer.maxDeviation = maxDeviation
  }

  return { layers, entries, desiredCount: targets.length }
}
