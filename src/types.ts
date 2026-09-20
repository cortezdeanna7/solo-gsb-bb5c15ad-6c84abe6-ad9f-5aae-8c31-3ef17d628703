/**
 * 应用领域类型
 */

/** 事件（时间轴上的一个待定位的点） */
export interface TEvent {
  id: string
  name: string
  note?: string
}

/** 关系方向：A 早于 B，或 A 晚于 B */
export type Relation = 'earlier' | 'later'

/**
 * 一条“事件 A 比事件 B {早|晚} min..max 分钟”的约束。
 * min <= max，单位为分钟（整数）。
 */
export interface Constraint {
  id: string
  aId: string
  bId: string
  relation: Relation
  min: number
  max: number
  enabled: boolean
}

/**
 * 一条绝对时间观测：事件 eventId 的实际时刻落在 [earliest, latest] 之间
 * （本地时间，datetime-local 格式 yyyy-MM-ddTHH:mm，精确到分钟）。
 * earliest === latest 时为精确时刻，即零宽区间。
 */
export interface Observation {
  id: string
  eventId: string
  /** 观测区间最早时刻（含）；与 latest 相等表示精确时刻 */
  earliest: string
  /** 观测区间最晚时刻（含） */
  latest: string
  /** 与约束一致支持临时停用（修复预览 / 人工排查） */
  enabled: boolean
}

/** 期望时刻的优先级层级：高 / 中 / 低（按此顺序做字典序最小化） */
export type PriorityLevel = 'high' | 'medium' | 'low'

/** 应用持久化状态 */
export interface AppState {
  events: TEvent[]
  constraints: Constraint[]
  /** 绝对时间观测区间（可多条；精确时刻为零宽区间；旧版单锚点存档自动迁移为其中一条） */
  observations: Observation[]
  /** 各事件的期望时刻（事件 id -> 本地时间 ISO）；仅与观测连通的事件参与最小偏差排程 */
  desiredTimes: Record<string, string>
  /**
   * 各事件期望时刻的优先级层级（事件 id -> 高/中/低）。
   * 仅对填写了期望时刻的事件有意义；缺省按「中」处理（兼容旧版存档）。
   */
  desiredPriorities: Record<string, PriorityLevel>
}

/**
 * 差分图中的一条有向边 u -> v，权重 w（分钟），表示 t_v - t_u <= w。
 *
 * 来源（origin）有两类：
 * - 'constraint'：由相对时序约束产生，sourceId 为约束 id；
 * - 'observation'：由绝对时间观测产生，sourceId 为观测 id，
 *   其对端可能是虚拟“绝对时间零点”节点（clock node）。
 */
export interface DiffEdge {
  u: number
  v: number
  w: number
  /** 来源类型：相对约束 / 绝对观测 */
  origin: 'constraint' | 'observation'
  /** 产生该边的约束或观测 id */
  sourceId: string
  /** 该边是来源的上界侧还是下界侧 */
  bound: 'upper' | 'lower'
}

/** 差分边的稳定标识（来源 + id + 上/下界侧） */
export function edgeKey(e: DiffEdge): string {
  return `${e.origin}:${e.sourceId}:${e.bound}`
}

export interface AnalysisResult {
  /** 是否存在矛盾（负环） */
  satisfiable: boolean
  /** 命中的一条矛盾环（按沿环行走的顺序） */
  cycle?: CycleInfo
  /** 每个事件的时间窗（仅可满足时计算，下标为事件下标） */
  windows: Map<number, WindowInfo>
  /** 虚拟“绝对时间零点”节点下标；无任何有效观测时为 null */
  clockIdx: number | null
}

export interface CycleInfo {
  /** 环上的节点，按环顺序，首尾不重复；可能含虚拟时间零点节点 */
  nodes: number[]
  /** 环上的边，edges[i] 从 nodes[i] 指向 nodes[(i+1) % n] */
  edges: DiffEdge[]
  /** 环上权重之和（严格小于 0） */
  totalWeight: number
  /** 环是否涉及至少一条绝对观测（即观测之间或观测与相对约束的冲突） */
  involvesObservation: boolean
}

export type WindowStatus = 'bounded' | 'oneSided' | 'disconnected'

export interface WindowInfo {
  status: WindowStatus
  /** 最早时刻（绝对时间，距 Unix 纪元的分钟数）；单边/不可达时为 null（-∞） */
  earliestMin: number | null
  /** 最晚时刻（绝对时间，距 Unix 纪元的分钟数）；单边/不可达时为 null（+∞） */
  latestMin: number | null
  /** 该事件自身是否录入了有效观测（用于表格标记；零宽区间也为 true） */
  observed: boolean
}

/**
 * 边界追溯中的一步：沿一条差分边把边界从 from 事件推进到 to 事件。
 * edge 始终为原始图方向的差分边（u -> v，权 w 表示 t_v - t_u <= w）；
 * 最早边界在反向图上推导，此时行走方向 from -> to 与 edge.u -> edge.v 相反。
 * from / to 可能是虚拟“绝对时间零点”节点。
 */
export interface BoundTraceStep {
  /** 本步采用的原始差分边（含来源类型、来源 id 与上/下界侧） */
  edge: DiffEdge
  /** 推导方向上的起点下标（从时间零点出发） */
  from: number
  /** 推导方向上的终点下标 */
  to: number
  /** 走完该步后，to 的绝对时刻界（距 Unix 纪元分钟数） */
  cumulative: number
}

/**
 * 某事件最早/最晚边界的推导链：从绝对时间零点出发的紧约束链。
 * steps 按推导顺序排列；若第一步就是观测边，则该边界直接由观测给出。
 */
export interface BoundTrace {
  /** 目标事件下标 */
  eventIdx: number
  /** 虚拟时间零点下标 */
  clockIdx: number
  /** 追溯的是最早边界还是最晚边界 */
  kind: 'earliest' | 'latest'
  /** 推导出的边界值：绝对时刻（距 Unix 纪元分钟数） */
  offset: number
  /** 从时间零点出发按推导顺序排列的步骤（至少 1 步；不可达时 traceBound 返回 null） */
  steps: BoundTraceStep[]
}

/** 分层最小偏差排程中单个事件的结果 */
export interface ScheduleEntry {
  eventIdx: number
  status: 'scheduled' | 'unscheduled'
  /** 实际排程时刻（距 Unix 纪元分钟数）；未定时为 null */
  actualMin: number | null
  /** 期望时刻（距 Unix 纪元分钟数）；未填写或无效为 null */
  desiredMin: number | null
  /** 实际 − 期望（分钟）；仅对已填写期望且已定时的事件 */
  deviation: number | null
  /** 期望因事件未与任何观测连通而被忽略 */
  desiredIgnored: boolean
  /** 该事件期望时刻的优先级层级；未填写期望为 null（未填写层级时按「中」） */
  priority: PriorityLevel | null
}

/** 分层最小偏差排程中单层（高/中/低）的结果 */
export interface LayerResult {
  /** 本层层级 */
  level: PriorityLevel
  /** 本层参与整体搜索的期望事件数量 */
  count: number
  /**
   * 本层的最优容差 D（分钟）：在全部更高层容差已固定的前提下，
   * 使本层全部期望 |实际 − 期望| ≤ D 同时可满足的最小非负整数；
   * 本层无参与事件时为 null
   */
  D: number | null
  /** 本层达到 |偏差| = D 的事件下标（按事件顺序） */
  tightEventIdx: number[]
  /** 本层期望事件在最终排程中的最大 |偏差|（整数输入下等于 D）；无参与事件为 null */
  maxDeviation: number | null
}

/**
 * 分层最小偏差排程结果。
 * 对当前有效差分系统（相对约束 + 全部绝对观测，含虚拟时间零点节点）按
 * 高 → 中 → 低 做字典序最小化：先求高优先级的最小最大偏差 D_高，把 ±D_高
 * 的钉住约束固定进边集后再求下一层；最终输出一份同时满足全部启用约束、
 * 全部观测与各层容差的确定性排程（同一累计差分图上的可行势）。
 */
export interface ScheduleResult {
  /** 各层结果，固定为高、中、低三层并按字典序优化顺序排列 */
  layers: LayerResult[]
  /** 每个事件的排程条目（按事件顺序） */
  entries: ScheduleEntry[]
  /** 参与整体搜索的期望事件总数（各层 count 之和） */
  desiredCount: number
}

/**
 * 最小修复方案：停用 disableItems 中的约束/观测后，差分系统恢复可满足。
 */
export interface RepairPlan {
  /** 建议停用的条目（约束或观测），按录入顺序排序 */
  disableItems: RepairDisableItem[]
  /** 停用上述条目后，每个事件的绝对时间窗 */
  windows: Map<number, WindowInfo>
}

/** 修复方案中需停用的一条来源（相对约束或绝对观测） */
export interface RepairDisableItem {
  origin: 'constraint' | 'observation'
  sourceId: string
}

/** 最小修复搜索结果 */
export interface RepairSearchResult {
  /** 是否找到至少一个可满足修复方案 */
  found: boolean
  /** 并列最优方案，最多 5 个，按停用条目的录入顺序稳定排序 */
  plans: RepairPlan[]
  /** 已找到的并列最优方案总数（可能大于 plans.length；截断时为下界） */
  totalPlans: number
  /** 每个方案需停用的条目数量（found 为 true 时即已证明的最小停用数） */
  disableCount: number
  /** 是否因达到累计状态数上限而提前停止（结果可能不完备） */
  truncated: boolean
  /** 最小停用数是否已被证明（found 为 true 时恒为 true） */
  optimumProven: boolean
  /** 累计访问的搜索状态数 */
  statesVisited: number
  /** 状态数上限（默认 2000） */
  stateLimit: number
}
