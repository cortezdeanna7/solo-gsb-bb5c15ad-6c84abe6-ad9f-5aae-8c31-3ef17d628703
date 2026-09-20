import {
  analyze,
  buildEdges,
  constraintToEdges,
  observationToEdges,
  traceBound,
} from '../src/lib/graph'
import { DEFAULT_STATE_LIMIT, findMinimalRepairs, MAX_PLANS } from '../src/lib/repair'
import { computeMinDeviationSchedule } from '../src/lib/schedule'
import { buildConsistentSample, buildContradictionSample } from '../src/lib/samples'
import { migrateState } from '../src/lib/storage'
import { epochMinToLocal, localToEpochMin, plusMinutesISO } from '../src/lib/format'
import type {
  Constraint,
  LayerResult,
  Observation,
  PriorityLevel,
  ScheduleResult,
  TEvent,
} from '../src/types'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error('FAIL:', msg)
  }
}

function approxEq(a: number | null, b: number | null) {
  if (a === null || b === null) return a === b
  return a === b
}

const ANCHOR_ISO = '2026-01-01T08:00'
/** 相对固定基准时间的 datetime-local 字符串 */
function isoPlus(min: number): string {
  return plusMinutesISO(ANCHOR_ISO, min)
}
const T0 = localToEpochMin(ANCHOR_ISO)!

// ==================== 边转换 ====================

// ---- 单条相对约束的边转换 ----
{
  const c: Constraint = {
    id: 'c1', aId: 'A', bId: 'B', relation: 'earlier', min: 3, max: 8, enabled: true,
  }
  const idx = new Map([['A', 0], ['B', 1]])
  const es = constraintToEdges(c, (id) => idx.get(id)!)
  // earlier: A->B +8 (t_B - t_A <= 8), B->A -3 (t_A - t_B <= -3)
  assert(es.some((e) => e.u === 0 && e.v === 1 && e.w === 8 && e.origin === 'constraint'), 'earlier 上界边 A->B +8')
  assert(es.some((e) => e.u === 1 && e.v === 0 && e.w === -3 && e.origin === 'constraint'), 'earlier 下界边 B->A -3')

  const c2: Constraint = {
    id: 'c2', aId: 'A', bId: 'B', relation: 'later', min: 3, max: 8, enabled: true,
  }
  const es2 = constraintToEdges(c2, (id) => idx.get(id)!)
  assert(es2.some((e) => e.u === 1 && e.v === 0 && e.w === 8), 'later 上界边 B->A +8')
  assert(es2.some((e) => e.u === 0 && e.v === 1 && e.w === -3), 'later 下界边 A->B -3')
}

// ---- 单条观测的边转换（精确时刻 = 零宽区间）----
{
  const idx = new Map([['A', 0]])
  const clock = 1
  const exact: Observation = {
    id: 'o1', eventId: 'A', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true,
  }
  const es = observationToEdges(exact, (id) => idx.get(id)!, clock)
  assert(es.length === 2, '观测产生 2 条边')
  assert(
    es.some((e) => e.u === clock && e.v === 0 && e.w === T0 && e.origin === 'observation' && e.bound === 'upper'),
    '精确观测上界边 clock->A 权 = 绝对时刻（纪元分钟）',
  )
  assert(
    es.some((e) => e.u === 0 && e.v === clock && e.w === -T0 && e.origin === 'observation' && e.bound === 'lower'),
    '精确观测下界边 A->clock 权 = −绝对时刻',
  )

  const range: Observation = {
    id: 'o2', eventId: 'A', earliest: isoPlus(-5), latest: isoPlus(10), enabled: true,
  }
  const es2 = observationToEdges(range, (id) => idx.get(id)!, clock)
  assert(es2.some((e) => e.u === clock && e.v === 0 && e.w === T0 + 10), '区间观测上界 = hi')
  assert(es2.some((e) => e.u === 0 && e.v === clock && e.w === -(T0 - 5)), '区间观测下界 = −lo')

  // 非法观测（lo > hi）不产生边
  const bad: Observation = {
    id: 'o3', eventId: 'A', earliest: isoPlus(10), latest: isoPlus(0), enabled: true,
  }
  assert(observationToEdges(bad, (id) => idx.get(id)!, clock).length === 0, '左右颠倒的观测不产生边')
}

// ---- 禁用约束 / 无观测时的图结构 ----
{
  const state = buildConsistentSample()
  const all = buildEdges(state.events, state.constraints, state.observations)
  assert(all.clockIdx === state.events.length, '存在观测时时间零点节点 = 事件数')
  assert(
    all.edges.filter((e) => e.origin === 'constraint').length === state.constraints.length * 2,
    '每条约束产生 2 条边',
  )
  assert(
    all.edges.filter((e) => e.origin === 'observation').length === state.observations.length * 2,
    '每条观测产生 2 条边',
  )
  const disabledC = state.constraints.map((c) => ({ ...c, enabled: false }))
  const onlyObs = buildEdges(state.events, disabledC, state.observations)
  assert(
    onlyObs.edges.every((e) => e.origin === 'observation'),
    '全部约束停用后只剩观测边',
  )
  const none = buildEdges(state.events, disabledC, [])
  assert(none.edges.length === 0 && none.clockIdx === null, '无启用约束且无观测时无边、无零点节点')
}

// ==================== 时间窗 ====================

// ---- 可满足示例的窗口（精确观测等价旧锚点；复盘另有区间观测）----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.observations)
  assert(r.satisfiable, '可满足示例判定为可满足')
  assert(!r.cycle, '可满足示例无矛盾链')
  assert(r.clockIdx === s.events.length, 'clockIdx 正确')
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const w = (name: string) => r.windows.get(byName.get(name)!)!
  const t0 = localToEpochMin(s.observations[0].earliest)!

  assert(approxEq(w('值班告警触发').earliestMin, t0), '告警最早 = 精确观测时刻')
  assert(approxEq(w('值班告警触发').latestMin, t0), '告警最晚 = 精确观测时刻')
  assert(w('值班告警触发').observed, '告警标记为有观测')
  assert(approxEq(w('值班工程师介入').earliestMin, t0 + 2), '介入最早 T0+2')
  assert(approxEq(w('值班工程师介入').latestMin, t0 + 5), '介入最晚 T0+5')
  assert(approxEq(w('定位到故障节点').earliestMin, t0 + 5), '定位最早 T0+5')
  assert(approxEq(w('定位到故障节点').latestMin, t0 + 15), '定位最晚 T0+15')
  assert(approxEq(w('完成流量切换').earliestMin, t0 + 6), '切换最早 T0+6')
  assert(approxEq(w('完成流量切换').latestMin, t0 + 19), '切换最晚 T0+19（受恢复反推约束）')
  assert(approxEq(w('服务恢复').earliestMin, t0 + 10), '恢复最早 T0+10（受"定位早于恢复5~15"收紧）')
  assert(approxEq(w('服务恢复').latestMin, t0 + 20), '恢复最晚 T0+20（整体约束）')
  // 复盘有区间观测 [+100,+150]，与约束窗 [+70,+200] 取交集
  assert(approxEq(w('复盘会议').earliestMin, t0 + 100), '复盘最早 T0+100（观测收紧）')
  assert(approxEq(w('复盘会议').latestMin, t0 + 150), '复盘最晚 T0+150（观测收紧）')
  assert(w('复盘会议').observed, '复盘标记为有观测')
  assert(w('媒体报道').status === 'disconnected', '媒体报道未连通 -> 无法定时')
  assert(approxEq(w('媒体报道').earliestMin, null) && approxEq(w('媒体报道').latestMin, null), '无法定时事件双侧无界')
}

// ---- 多观测：两条精确观测 + 相对约束共同决定中间事件窗口 ----
{
  // A 精确于 T0，C 精确于 T0+30；B 比 A 晚 0~…、C 比 B 晚 0~…（B 在 A 之后、C 之前）
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 0, max: 100, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 0, max: 100, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
    { id: 'o2', eventId: 'c', earliest: isoPlus(30), latest: isoPlus(30), enabled: true },
  ]
  const r = analyze(events, cs, obs)
  assert(r.satisfiable, '双观测 + 链式约束可满足')
  const wb = r.windows.get(1)!
  assert(wb.earliestMin === T0 && wb.latestMin === T0 + 30, 'B 被两侧观测夹在 [T0, T0+30]')
  assert(!wb.observed && wb.status === 'bounded', 'B 自身无观测但可定时')
}

// ---- 观测之间直接冲突（同一事件两条互斥精确观测）----
{
  const events: TEvent[] = [{ id: 'a', name: 'A' }]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
    { id: 'o2', eventId: 'a', earliest: isoPlus(10), latest: isoPlus(10), enabled: true },
  ]
  const r = analyze(events, [], obs)
  assert(!r.satisfiable, '同一事件两条互斥精确观测 => 矛盾')
  assert(r.cycle !== undefined, '提取出矛盾链')
  assert(r.cycle!.involvesObservation, '矛盾链标记 involvesObservation')
  const obsIds = new Set(r.cycle!.edges.map((e) => e.sourceId))
  assert(obsIds.has('o1') && obsIds.has('o2'), '矛盾链同时包含两条观测（不逐锚点独立判断）')
  // 链上节点包含时间零点与事件
  assert(r.cycle!.nodes.includes(r.clockIdx!), '观测间矛盾链经过时间零点')
}

// ---- 观测与相对约束冲突：矛盾链必须同时含观测与原约束 ----
{
  // A 精确于 T0；约束：B 比 A 晚 10~20；B 精确于 T0+5（落在窗口外）
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
    { id: 'o2', eventId: 'b', earliest: isoPlus(5), latest: isoPlus(5), enabled: true },
  ]
  const r = analyze(events, cs, obs)
  assert(!r.satisfiable, '观测落在约束窗口外 => 矛盾')
  const cyc = r.cycle!
  assert(cyc.involvesObservation, '矛盾链含观测')
  const origins = new Set(cyc.edges.map((e) => e.origin))
  assert(origins.has('observation') && origins.has('constraint'), '矛盾链同时引用观测与相对约束')
  // 下界 10 被违反：t_A − t_B ≤ −10 与 B 精确 T0+5（t_B ≤ T0+5）、A 精确 T0（−t_A ≤ −T0）
  // 沿 clock->A(T0)、B->A? 检查总权重 < 0 且含约束下界边（权 −10）
  assert(cyc.totalWeight < 0, '矛盾链总权重为负')
  assert(
    cyc.edges.some((e) => e.origin === 'constraint' && e.sourceId === 'c1'),
    '矛盾链引用了具体的相对约束 c1',
  )
  assert(
    cyc.edges.some((e) => e.origin === 'observation' && (e.sourceId === 'o1' || e.sourceId === 'o2')),
    '矛盾链引用了具体观测',
  )
}

// ---- 区间观测与约束冲突（观测区间与可行域不相交）----
{
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
    // B 被观测在 T0-10 ~ T0+5，但约束要求 B ≥ T0+10
    { id: 'o2', eventId: 'b', earliest: isoPlus(-10), latest: isoPlus(5), enabled: true },
  ]
  const r = analyze(events, cs, obs)
  assert(!r.satisfiable, '区间观测与约束不相交 => 矛盾')
  assert(r.cycle!.edges.some((e) => e.origin === 'constraint'), '链上有原约束')
  assert(r.cycle!.edges.some((e) => e.origin === 'observation'), '链上有观测')
}

// ---- 矛盾示例（纯相对约束负环）：观测不参与该环 ----
{
  const s = buildContradictionSample()
  const r = analyze(s.events, s.constraints, s.observations)
  assert(!r.satisfiable, '矛盾示例判定为不可满足')
  assert(!!r.cycle, '提取出矛盾环')
  if (r.cycle) {
    assert(r.cycle.totalWeight === -25, '环权重之和 = -25')
    assert(!r.cycle.involvesObservation, '纯约束矛盾环不含观测')
    // 环必须覆盖 A、B、C（不含 D、不含零点）
    const names = r.cycle.nodes.map((i) => s.events[i]?.name?.[0]).sort()
    assert(JSON.stringify(names) === JSON.stringify(['A', 'B', 'C']), '环为 A-B-C')
    // 校验 edges[i] 从 nodes[i] 指向 nodes[(i+1)%n]
    const n = r.cycle.nodes.length
    let aligned = true
    for (let i = 0; i < n; i++) {
      const e = r.cycle.edges[i]
      if (e.u !== r.cycle.nodes[i] || e.v !== r.cycle.nodes[(i + 1) % n]) aligned = false
    }
    assert(aligned, '环边与环节点严格对齐 edges[i]: nodes[i] -> nodes[i+1]')
    const sum = r.cycle.edges.reduce((a, e) => a + e.w, 0)
    assert(sum === r.cycle.totalWeight, '环权重求和一致')
  }
}

// ---- 精确间隔约束（min == max）：窗口退化为点 ----
{
  const s = buildConsistentSample()
  const t0 = localToEpochMin(s.observations[0].earliest)!
  s.constraints = s.constraints.map((c) =>
    c.aId === s.events[1].id ? { ...c, min: 4, max: 4 } : c,
  )
  const r = analyze(s.events, s.constraints, s.observations)
  const w = r.windows.get(1)!
  assert(r.satisfiable, '改精确间隔后仍可满足')
  assert(w.earliestMin === t0 + 4 && w.latestMin === t0 + 4, '介入窗口退化为 T0+4 单点')
}

// ---- 空系统 / 无观测 ----
{
  const r0 = analyze([], [], [])
  assert(r0.satisfiable && r0.clockIdx === null, '空系统可满足且无零点')
  const s = buildConsistentSample()
  const r1 = analyze(s.events, s.constraints, [])
  assert(r1.satisfiable, '无观测时系统仍判可满足')
  assert(r1.clockIdx === null, '无观测时无零点节点')
  assert(
    [...r1.windows.values()].every((w) => w.status === 'disconnected'),
    '无观测时全部无法定时',
  )
}

// ---- 经典矛盾：A 早于 B 10 分钟，又晚于 B 5 分钟（两点环）----
{
  const ev = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]
  const cs: Constraint[] = [
    { id: 'x', aId: 'a', bId: 'b', relation: 'earlier', min: 10, max: 20, enabled: true },
    { id: 'y', aId: 'a', bId: 'b', relation: 'later', min: 5, max: 8, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
  ]
  const r = analyze(ev, cs, obs)
  assert(!r.satisfiable, '双向时间冲突判为矛盾')
  assert(r.cycle !== undefined && r.cycle.totalWeight < 0, '两点负环权重为负')
}

// ---- 无法定时：观测只覆盖一个独立连通分量 ----
{
  // A 精确于 T0；B 与 A 有约束（可定时）；C、D 在另一分量内（无任何观测连通）
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c2', aId: 'd', bId: 'c', relation: 'later', min: 0, max: 10, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
  ]
  const r = analyze(events, cs, obs)
  assert(r.satisfiable, '场景可满足')
  assert(r.windows.get(1)!.status === 'bounded', 'B 与 A 同分量 => 可定时')
  assert(r.windows.get(2)!.status === 'disconnected', 'C 未被任何观测连通 => 无法定时')
  assert(r.windows.get(3)!.status === 'disconnected', 'D 未被任何观测连通 => 无法定时')
}

// ==================== 存档迁移 ====================

// ---- 旧版单锚点存档自动迁移为一条精确观测 ----
{
  const old = {
    events: [{ id: 'e1', name: 'A' }, { id: 'e2', name: 'B' }],
    constraints: [],
    anchorId: 'e1',
    anchorTime: ANCHOR_ISO,
  }
  const m = migrateState(old as any)
  assert(m !== null && m.observations.length === 1, '旧存档迁移出 1 条观测')
  const o = m!.observations[0]
  assert(o.eventId === 'e1' && o.earliest === ANCHOR_ISO && o.latest === ANCHOR_ISO, '迁移观测为锚点精确时刻（零宽）')
  assert(o.enabled === true && typeof o.id === 'string', '迁移观测启用且带 id')
  assert((m!.any as any) === undefined && !('anchorId' in m!), '迁移后清除旧 anchorId 字段')

  // 迁移后的存档可直接被 analyze 使用：锚点事件窗口退化为点，其余未连通
  const r = analyze(m!.events, m!.constraints, m!.observations)
  assert(r.satisfiable, '迁移存档可分析')
  assert(r.windows.get(0)!.earliestMin === T0 && r.windows.get(0)!.latestMin === T0, '迁移观测给出绝对时间')
  assert(r.windows.get(1)!.status === 'disconnected', '未观测连通的事件仍无法定时')
}

// ---- 存档迁移：无锚点 / 锚点事件已删除 / 已含观测 ----
{
  const noAnchor = migrateState({ events: [], constraints: [] } as any)
  assert(noAnchor !== null && noAnchor.observations.length === 0, '无锚点旧存档迁移为空观测集')

  const dangling = migrateState({
    events: [{ id: 'e9', name: 'X' }],
    constraints: [],
    anchorId: 'missing',
    anchorTime: ANCHOR_ISO,
  } as any)
  assert(dangling!.observations.length === 0, '锚点事件已删除时不迁移观测')

  const already = {
    events: [{ id: 'e1', name: 'A' }],
    constraints: [],
    observations: [
      { id: 'oX', eventId: 'e1', earliest: isoPlus(0), latest: isoPlus(5), enabled: true },
    ],
  }
  const kept = migrateState(already as any)
  assert(kept!.observations.length === 1 && kept!.observations[0].id === 'oX', '已含观测的存档原样保留')

  // 结构非法观测剔除；左右颠倒（编辑中间态）的观测保留，由图构建与界面处理
  const dirty = migrateState({
    events: [{ id: 'e1', name: 'A' }],
    constraints: [],
    observations: [
      { id: 'bad', eventId: 'e1', earliest: isoPlus(9), latest: isoPlus(0), enabled: true },
      { id: 'good', eventId: 'e1', earliest: isoPlus(0), latest: isoPlus(1), enabled: false },
      { id: 'ghost', eventId: 'nope', earliest: isoPlus(0), latest: isoPlus(1), enabled: true },
    ],
  } as any)
  const ids = dirty!.observations.map((o) => o.id).sort()
  assert(JSON.stringify(ids) === JSON.stringify(['bad', 'good']), '剔除悬空事件观测，保留合法与左右颠倒观测')
  assert(dirty!.observations.find((o) => o.id === 'good')!.enabled === false, '被保留观测的停用标志原样保留')
  // 颠倒观测在图构建时被忽略；停用观测同样不产生边（二者都不计入时间零点）
  const r = analyze(dirty!.events, dirty!.constraints, dirty!.observations)
  assert(r.satisfiable && r.clockIdx === null, '颠倒/停用观测不产生边、无时间零点、不阻断系统')
  // 把 good 启用后，仅有它一条有效观测参与建图
  const enabled = dirty!.observations.map((o) => (o.id === 'good' ? { ...o, enabled: true } : o))
  const r2 = analyze(dirty!.events, dirty!.constraints, enabled)
  assert(r2.satisfiable && r2.clockIdx === 1, '启用合法观测后时间零点出现')
  assert(r2.windows.get(0)!.observed, '合法观测正常给出绝对时间窗')
}

// ==================== 最小修复 ====================

// ---- 最小修复：纯约束矛盾示例最少停用 1 条，3 个并列方案 ----
{
  const s = buildContradictionSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.observations)
  assert(r.found, '矛盾示例找到修复方案')
  assert(r.disableCount === 1, '矛盾示例最少停用 1 条')
  assert(r.optimumProven && !r.truncated, '最优性已证明且未截断')
  assert(r.totalPlans === 3, `3 个并列最优方案（实际 ${r.totalPlans}）`)
  assert(r.plans.length === 3, '展示全部 3 个方案（≤5）')

  const ringIds = s.constraints.slice(0, 3).map((c) => c.id)
  for (const plan of r.plans) {
    assert(plan.disableItems.length === 1, '每个方案停用恰好 1 条')
    assert(plan.disableItems[0].origin === 'constraint', '停用的是约束（观测与该环无关）')
    assert(ringIds.includes(plan.disableItems[0].sourceId), '停用的是矛盾环上的约束')
  }

  const orders = r.plans.map((p) =>
    s.constraints.findIndex((c) => c.id === p.disableItems[0].sourceId),
  )
  assert(JSON.stringify(orders) === JSON.stringify([0, 1, 2]), '方案按录入顺序排序')

  for (const plan of r.plans) {
    const off = new Set(plan.disableItems.map((d) => d.sourceId))
    const sim = s.constraints.map((c) => (off.has(c.id) ? { ...c, enabled: false } : c))
    const ar = analyze(s.events, sim, s.observations)
    assert(ar.satisfiable, '按方案停用后系统可满足')
  }
}

// ---- 最小修复：观测与约束冲突时，观测/约束都可作为修复候选 ----
{
  // A=T0；B 比 A 晚 10~20；B 被精确观测于 T0+5。
  // 修复可停用 c1（相对约束）或 o2（B 的观测）；停用 o1（A 的观测）无法解链。
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
    { id: 'o2', eventId: 'b', earliest: isoPlus(5), latest: isoPlus(5), enabled: true },
  ]
  assert(!analyze(events, cs, obs).satisfiable, '前置：系统矛盾')
  const r = findMinimalRepairs(events, cs, obs)
  assert(r.found && r.disableCount === 1, '观测/约束冲突最少停用 1 条')
  assert(r.totalPlans === 3, `3 个并列方案（停 c1 / o1 / o2，实际 ${r.totalPlans}）`)
  const keys = r.plans.map((p) => `${p.disableItems[0].origin}:${p.disableItems[0].sourceId}`).sort()
  assert(keys.includes('constraint:c1'), '候选：停用相对约束 c1')
  assert(keys.includes('observation:o1'), '候选：停用锚定观测 o1')
  assert(keys.includes('observation:o2'), '候选：停用问题观测 o2')

  // 每个方案修复后确实可满足
  for (const plan of r.plans) {
    const offC = new Set(plan.disableItems.filter((d) => d.origin === 'constraint').map((d) => d.sourceId))
    const offO = new Set(plan.disableItems.filter((d) => d.origin === 'observation').map((d) => d.sourceId))
    const ar = analyze(
      events,
      cs.map((c) => (offC.has(c.id) ? { ...c, enabled: false } : c)),
      obs.map((o) => (offO.has(o.id) ? { ...o, enabled: false } : o)),
    )
    assert(ar.satisfiable, '混合修复方案停用后可满足')
  }
}

// ---- 最小修复：两条互斥观测，停用其中任意一条（2 个并列方案）----
{
  const events: TEvent[] = [{ id: 'a', name: 'A' }]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
    { id: 'o2', eventId: 'a', earliest: isoPlus(10), latest: isoPlus(10), enabled: true },
  ]
  const r = findMinimalRepairs(events, [], obs)
  assert(r.found && r.disableCount === 1, '互斥观测最少停用 1 条')
  assert(r.totalPlans === 2, '停用 o1 或 o2 两个并列方案')
  assert(r.plans.every((p) => p.disableItems[0].origin === 'observation'), '方案全部针对观测')
}

// ---- 最小修复：两个互不相交的负环需各停 1 条（最少 2 条，9 个并列方案）----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
    { id: 'd', name: 'D' }, { id: 'e', name: 'E' }, { id: 'f', name: 'F' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'a', bId: 'c', relation: 'later', min: 10, max: 30, enabled: true },
    { id: 'c4', aId: 'e', bId: 'd', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c5', aId: 'f', bId: 'e', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c6', aId: 'd', bId: 'f', relation: 'later', min: 10, max: 30, enabled: true },
  ]
  assert(!analyze(events, cs, []).satisfiable, '双环系统存在矛盾')
  const r = findMinimalRepairs(events, cs, [])
  assert(r.found && r.disableCount === 2, '双环最少停用 2 条')
  assert(r.totalPlans === 9, `9 个并列方案（3×3，实际 ${r.totalPlans}）`)
  assert(r.plans.length === MAX_PLANS, '最多展示 5 个')
  assert(!r.truncated, '9 个状态的搜索远未达上限，不截断')

  for (const plan of r.plans) {
    const idx = plan.disableItems.map((d) => cs.findIndex((c) => c.id === d.sourceId))
    assert(idx.length === 2, '方案停用 2 条')
    assert(idx[0] < 3 && idx[1] >= 3, '两环各停用 1 条')
  }
  const firstFive = r.plans.map((p) =>
    p.disableItems.map((d) => cs.findIndex((c) => c.id === d.sourceId)),
  )
  assert(
    JSON.stringify(firstFive) === JSON.stringify([[0, 3], [0, 4], [0, 5], [1, 3], [1, 4]]),
    '截断展示录入顺序最靠前的 5 个',
  )
}

// ---- 最小修复：状态数上限触发，明确标记可能不完备 ----
{
  const s = buildContradictionSample()
  const r0 = findMinimalRepairs(s.events, s.constraints, s.observations, { stateLimit: 1 })
  assert(!r0.found, '上限 1（仅根状态）时未找到方案')
  assert(r0.truncated && !r0.optimumProven, '标记截断且最优性未证明')
  assert(r0.stateLimit === 1 && r0.statesVisited === 1, '回传上限与已访问状态数')

  const r1 = findMinimalRepairs(s.events, s.constraints, s.observations, { stateLimit: 3 })
  assert(r1.found && r1.disableCount === 1, '上限 3 时在第 1 层找到最优')
  assert(r1.truncated, '同层未探索完：标记截断（结果可能不完备）')
  assert(r1.plans.length === 2, '只展示已探索到的 2 个并列方案')
}

// ---- 最小修复：常量默认值 / 可满足系统无需修复 ----
{
  assert(DEFAULT_STATE_LIMIT === 2000, '默认搜索上限为 2000 个状态')
  assert(MAX_PLANS === 5, '并列方案最多展示 5 个')

  const s = buildConsistentSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.observations)
  assert(r.found && r.plans.length === 0 && r.disableCount === 0, '可满足系统返回空方案、停用数 0')
  assert(!r.truncated && r.optimumProven, '可满足系统不截断')
}

// ---- 最小修复：已停用 / 引用缺失事件的条目不进入候选 ----
{
  const s = buildContradictionSample()
  const disabled = s.constraints.map((c, i) =>
    i === 0 ? { ...c, enabled: false } : c,
  )
  const stillConflict = analyze(s.events, disabled, s.observations)
  assert(stillConflict.satisfiable, '手动停用环上一条后矛盾消除（与修复建议等价）')
  const r = findMinimalRepairs(s.events, disabled, s.observations)
  assert(r.found && r.disableCount === 0 && r.plans.length === 0, '已无可修复矛盾')
}

// ==================== 边界追溯 ====================

// ---- 追溯：最晚边界（正向图紧约束链，首步为观测）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const clockIdx = s.events.length
  const t0 = localToEpochMin(s.observations[0].earliest)!

  const t1 = traceBound(s.events, s.constraints, s.observations, byName.get('值班工程师介入')!, 'latest')!
  assert(t1 !== null && t1.offset === t0 + 5, '追溯：介入最晚 T0+5')
  assert(t1.clockIdx === clockIdx, '追溯：零点下标正确')
  assert(t1.steps.length === 2, '追溯：观测 1 步 + 约束 1 步')
  assert(t1.steps[0].edge.origin === 'observation', '追溯：链从观测边出发')
  assert(t1.steps[1].edge.bound === 'upper' && t1.steps[1].edge.w === 5, '追溯：采用约束上界侧 +5')
  assert(t1.steps[0].from === clockIdx, '追溯：链起点为时间零点')
  assert(t1.steps[1].to === byName.get('值班工程师介入')!, '追溯：链指向目标')
  assert(
    JSON.stringify(t1.steps.map((x) => x.cumulative)) === JSON.stringify([t0, t0 + 5]),
    '追溯：累计绝对时刻 T0、T0+5',
  )

  // 恢复最晚 T0+20：clock->A 观测 + A->恢复 +20 直达
  const t2 = traceBound(s.events, s.constraints, s.observations, byName.get('服务恢复')!, 'latest')!
  assert(t2.offset === t0 + 20 && t2.steps.length === 2, '追溯：恢复最晚为观测 + 单步直达')
  assert(t2.steps[1].edge.w === 20 && t2.steps[1].cumulative === t0 + 20, '追溯：恢复最晚累计 T0+20')
}

// ---- 追溯：最早边界正确还原反向图路径 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const clockIdx = s.events.length
  const t0 = localToEpochMin(s.observations[0].earliest)!
  const onCall = byName.get('值班工程师介入')!
  const recovered = byName.get('服务恢复')!

  // 反向图（从 clock 出发）按边序松弛：先经 A 精确观测下界的反向边（clock->A，权 −T0），
  // 再经「介入晚于告警 2~5」下界反向边（A->介入，权 −2）。
  // 展示时还原为原始边、按 clock->A->介入 的推导顺序排列。
  const t1 = traceBound(s.events, s.constraints, s.observations, onCall, 'earliest')!
  assert(t1.offset === t0 + 2, '追溯：介入最早 T0+2')
  assert(t1.steps.length === 2, '追溯：介入最早为 2 步链（反向观测 + 反向约束）')
  const stObs = t1.steps[0]
  assert(stObs.edge.origin === 'observation', '追溯：第 1 步为观测边')
  assert(stObs.edge.bound === 'lower' && stObs.edge.w === -t0, '追溯：采用观测下界侧（权 −T0）')
  assert(stObs.from === clockIdx && stObs.to === 0, '追溯：观测步行走 clock->A（原始边反向）')
  assert(stObs.edge.u === 0 && stObs.edge.v === clockIdx, '追溯：观测边还原为原始方向 A->clock')
  assert(stObs.cumulative === t0, '追溯：观测步累计绝对时刻 T0')
  const stConstraint = t1.steps[1]
  assert(stConstraint.edge.origin === 'constraint', '追溯：第 2 步为相对约束')
  assert(stConstraint.edge.bound === 'lower' && stConstraint.edge.w === -2, '追溯：采用约束下界侧（权 −2）')
  assert(stConstraint.edge.u === onCall, '追溯：约束边还原为原始方向')
  assert(stConstraint.from === 0 && stConstraint.to === onCall, '追溯：约束步行走 A->介入')
  assert(stConstraint.cumulative === t0 + 2, '追溯：最早累计为绝对时刻 T0+2')

  const t2 = traceBound(s.events, s.constraints, s.observations, recovered, 'earliest')!
  assert(t2.offset === t0 + 10, '追溯：恢复最早 T0+10')
  assert(t2.steps.length === 4, '追溯：恢复最早为 4 步链（观测 + 3 约束）')
  assert(t2.steps[0].from === clockIdx, '追溯：链起点为时间零点')
  assert(t2.steps[3].to === recovered, '追溯：链终点为目标事件')
  for (let i = 1; i < t2.steps.length; i++) {
    assert(t2.steps[i].from === t2.steps[i - 1].to, `追溯：第 ${i + 1} 步与上一步首尾相接`)
  }
  assert(
    JSON.stringify(t2.steps.map((x) => x.cumulative)) === JSON.stringify([t0, t0 + 2, t0 + 5, t0 + 10]),
    '追溯：累计绝对时刻 T0 / T0+2 / T0+5 / T0+10',
  )
  const origEdges = buildEdges(s.events, s.constraints, s.observations).edges
  for (const st of t2.steps) {
    assert(
      origEdges.some(
        (e) =>
          e.u === st.edge.u &&
          e.v === st.edge.v &&
          e.w === st.edge.w &&
          e.origin === st.edge.origin &&
          e.sourceId === st.edge.sourceId &&
          e.bound === st.edge.bound,
      ),
      '追溯：最早链上的边均来自原始图（反向路径已正确还原）',
    )
  }
}

// ---- 追溯：全部事件的追溯值与时间窗一致（性质校验）----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.observations)
  for (let i = 0; i < s.events.length; i++) {
    const w = r.windows.get(i)!
    for (const kind of ['earliest', 'latest'] as const) {
      const t = traceBound(s.events, s.constraints, s.observations, i, kind)
      const value = kind === 'earliest' ? w.earliestMin : w.latestMin
      if (value === null) {
        assert(t === null, `追溯：${s.events[i].name} ${kind} 无界时返回 null`)
        continue
      }
      assert(t !== null && t.offset === value, `追溯：${s.events[i].name} ${kind} 时刻与时间窗一致`)
      if (!t) continue
      assert(t.steps.length >= 1, '追溯：至少 1 步（观测或约束）')
      assert(t.steps[0].from === r.clockIdx, `追溯：${s.events[i].name} ${kind} 链起于时间零点`)
      assert(t.steps[t.steps.length - 1].to === i, `追溯：${s.events[i].name} ${kind} 链终于目标`)
      let contiguous = true
      for (let k = 1; k < t.steps.length; k++) {
        if (t.steps[k].from !== t.steps[k - 1].to) contiguous = false
      }
      assert(contiguous, `追溯：${s.events[i].name} ${kind} 链步步相接`)
      assert(
        t.steps[t.steps.length - 1].cumulative === t.offset,
        `追溯：${s.events[i].name} ${kind} 末步累计即边界值`,
      )
    }
  }
}

// ---- 追溯：无观测 / 非法下标 / 无法定时返回 null；停用条目后重算 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))

  assert(traceBound(s.events, s.constraints, [], 0, 'latest') === null, '追溯：无观测返回 null')
  assert(traceBound(s.events, s.constraints, s.observations, 999, 'latest') === null, '追溯：非法事件下标返回 null')

  const press = byName.get('媒体报道')!
  assert(traceBound(s.events, s.constraints, s.observations, press, 'earliest') === null, '追溯：无法定时事件最早返回 null')
  assert(traceBound(s.events, s.constraints, s.observations, press, 'latest') === null, '追溯：无法定时事件最晚返回 null')

  // 模拟修复预览：停用「恢复 晚于 告警 8~20」后，恢复最晚边界改走 4 步约束链（T0+25）
  const recovered = byName.get('服务恢复')!
  const overall = s.constraints.find((c) => c.min === 8 && c.max === 20)!
  const previewed = s.constraints.map((c) => (c.id === overall.id ? { ...c, enabled: false } : c))
  const t = traceBound(s.events, previewed, s.observations, recovered, 'latest')!
  const t0p = localToEpochMin(s.observations[0].earliest)!
  assert(t.offset === t0p + 25 && t.steps.length === 5, '追溯：停用整体约束后最晚边界按有效条目重算为 T0+25（5 步）')
  assert(
    JSON.stringify(t.steps.map((s2) => s2.cumulative)) === JSON.stringify([t0p, t0p + 5, t0p + 15, t0p + 21, t0p + 25]),
    '追溯：重算链累计 T0+5/15/21/25',
  )
  assert(!t.steps.some((s2) => s2.edge.sourceId === overall.id), '追溯：重算链不含已停用约束')
}

// ---- 追溯：边界直接由观测给出（零相对约束步）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const t0 = localToEpochMin(s.observations[0].earliest)!
  const alert = byName.get('值班告警触发')!
  const t = traceBound(s.events, s.constraints, s.observations, alert, 'latest')!
  assert(t.steps.length === 1 && t.offset === t0, '追溯：精确观测事件的链为单步观测')
  assert(t.steps[0].edge.origin === 'observation' && t.steps[0].cumulative === t0, '追溯：单步即观测边')

  // 复盘最晚由自身区间观测上界 T0+150 直接给出（比约束链 T0+200 更紧）
  const post = byName.get('复盘会议')!
  const tp = traceBound(s.events, s.constraints, s.observations, post, 'latest')!
  assert(tp.offset === t0 + 150, '追溯：复盘最晚 T0+150')
  assert(tp.steps[0].edge.origin === 'observation' && tp.steps[0].to === post, '追溯：复盘最晚首步直达观测边')
}

// ==================== 分层最小偏差排程 ====================

/** 取某一层（高/中/低）的结果 */
function layerOf(r: ScheduleResult, level: PriorityLevel): LayerResult {
  return r.layers.find((l) => l.level === level)!
}

/** 性质校验：满足全部启用约束、全部观测，每个期望偏差均在其所属层的 ±D 内 */
function scheduleFeasible(
  events: TEvent[],
  constraints: Constraint[],
  observations: Observation[],
  r: ScheduleResult,
): boolean {
  const idx = new Map(events.map((e, i) => [e.id, i]))
  for (const c of constraints) {
    if (!c.enabled) continue
    const ia = idx.get(c.aId)
    const ib = idx.get(c.bId)
    if (ia === undefined || ib === undefined) continue
    const ta = r.entries[ia].actualMin
    const tb = r.entries[ib].actualMin
    if (ta === null || tb === null) continue // 未连通分量不参与
    const diff = c.relation === 'earlier' ? tb! - ta! : ta! - tb!
    if (diff < c.min - 1e-9 || diff > c.max + 1e-9) return false
  }
  for (const o of observations) {
    if (!o.enabled) continue
    const i = idx.get(o.eventId)
    if (i === undefined) continue
    const t = r.entries[i].actualMin
    if (t === null) continue
    const lo = localToEpochMin(o.earliest)!
    const hi = localToEpochMin(o.latest)!
    if (t < lo - 1e-9 || t > hi + 1e-9) return false
  }
  return r.entries.every((en) => {
    if (en.deviation === null) return true
    const layer = layerOf(r, en.priority!)
    return layer.D !== null && Math.abs(en.deviation) <= layer.D + 1e-9
  })
}

// ---- 分层排程：全部默认「中」时退化为单层最小最大偏差（D=5，恢复达到 −D）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const recovered = byName.get('服务恢复')!
  const postmortem = byName.get('复盘会议')!
  const press = byName.get('媒体报道')!
  const t0 = localToEpochMin(s.observations[0].earliest)!
  const desired: Record<string, string> = {
    [s.events[recovered].id]: epochMinToLocal(t0 + 25),
    [s.events[postmortem].id]: epochMinToLocal(t0 + 120),
  }
  // 用单条精确观测等价旧锚点（去掉复盘区间观测，恢复旧用例的窗口口径）
  const obs = s.observations.filter((o) => o.eventId === s.events[byName.get('值班告警触发')!].id)
  const r = computeMinDeviationSchedule(s.events, s.constraints, obs, desired, {})!
  assert(r !== null, '排程：示例可计算')
  assert(r.layers.length === 3, '排程：固定输出高、中、低三层')
  const lm = layerOf(r, 'medium')
  assert(lm.D === 5, `排程：默认层级下中层最优 D=5（实际 ${lm.D}）`)
  assert(lm.count === 2 && r.desiredCount === 2, '排程：2 个期望事件参与整体搜索')
  assert(layerOf(r, 'high').count === 0 && layerOf(r, 'high').D === null, '排程：高层无参与事件')
  assert(layerOf(r, 'low').count === 0, '排程：低层无参与事件')
  const enRec = r.entries[recovered]
  assert(enRec.status === 'scheduled' && enRec.actualMin === t0 + 20, '排程：恢复被钉在窗口端点 T0+20')
  assert(enRec.deviation === -5, '排程：恢复偏差 −5（达到 −D）')
  assert(enRec.priority === 'medium', '排程：未指定层级时按「中」')
  assert(lm.tightEventIdx.includes(recovered), '排程：恢复列入中层达到 ±D 的事件')
  assert(lm.maxDeviation === 5, '排程：中层最大偏差恰为 D=5')
  const enPost = r.entries[postmortem]
  assert(enPost.deviation !== null && Math.abs(enPost.deviation) <= 5, '排程：复盘偏差在中层 ±D 内')
  const enPress = r.entries[press]
  assert(enPress.status === 'unscheduled' && enPress.actualMin === null, '排程：未连通事件标记未定时')
  assert(scheduleFeasible(s.events, s.constraints, obs, r), '排程：输出满足全部启用约束、观测且各层偏差 ≤ 本层 D')
}

// ---- 分层排程：内置示例（恢复=高、复盘=低；含复盘区间观测）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const recovered = byName.get('服务恢复')!
  const postmortem = byName.get('复盘会议')!
  const r = computeMinDeviationSchedule(
    s.events, s.constraints, s.observations, s.desiredTimes, s.desiredPriorities,
  )!
  assert(r !== null, '排程：内置示例可计算')
  const lh = layerOf(r, 'high')
  const ll = layerOf(r, 'low')
  assert(lh.D === 5 && lh.count === 1, `排程：内置示例高层 D=5（实际 ${lh.D}）`)
  assert(lh.tightEventIdx.includes(recovered), '排程：恢复达到高层 ±D')
  assert(layerOf(r, 'medium').count === 0, '排程：内置示例中层为空')
  // 复盘期望 T0+120，落在观测区间 [T0+100,T0+150] 内，低层 D=0
  assert(ll.D === 0 && ll.count === 1, `排程：低层 D=0（实际 ${ll.D}）`)
  assert(ll.tightEventIdx.includes(postmortem), '排程：复盘达到低层 ±D（偏差 0）')
  assert(r.entries[recovered].priority === 'high' && r.entries[postmortem].priority === 'low', '排程：条目标注各自层级')
  assert(scheduleFeasible(s.events, s.constraints, s.observations, r), '排程：内置示例输出可行')
}

// ---- 分层排程：整体可满足性搜索，不能独立夹窗 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'x', name: 'X' }, { id: 'y', name: 'Y' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'x', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c2', aId: 'y', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c3', aId: 'y', bId: 'x', relation: 'later', min: 5, max: 5, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
  ]
  const win = analyze(events, cs, obs)
  const wx = win.windows.get(1)!
  const wy = win.windows.get(2)!
  assert(wx.earliestMin === T0 && wx.latestMin === T0 + 5, '排程：X 窗口被耦合收紧为 [T0,T0+5]')
  assert(wy.earliestMin === T0 + 5 && wy.latestMin === T0 + 10, '排程：Y 窗口被耦合收紧为 [T0+5,T0+10]')
  const r = computeMinDeviationSchedule(events, cs, obs, { x: isoPlus(10), y: isoPlus(0) }, {})!
  const lm = layerOf(r, 'medium')
  assert(lm.D === 8, `排程：耦合系统整体搜索得 D=8（实际 ${lm.D}），独立夹窗会误判为 5`)
  assert(lm.maxDeviation === 8 && lm.tightEventIdx.length >= 1, '排程：耦合系统有事件达到 ±D')
  assert(scheduleFeasible(events, cs, obs, r), '排程：耦合系统输出可行')
}

// ---- 分层排程：字典序——高层先把偏差压到 0，低层承担全部耦合代价 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'x', name: 'X' }, { id: 'y', name: 'Y' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'x', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c2', aId: 'y', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c3', aId: 'y', bId: 'x', relation: 'later', min: 0, max: 0, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
  ]
  const flat = computeMinDeviationSchedule(events, cs, obs, { x: isoPlus(10), y: isoPlus(0) }, {})!
  assert(layerOf(flat, 'medium').D === 5, '排程：同层平级时最小最大偏差 D=5（对照组）')

  const r = computeMinDeviationSchedule(
    events, cs, obs,
    { x: isoPlus(10), y: isoPlus(0) },
    { x: 'high', y: 'low' },
  )!
  assert(layerOf(r, 'high').D === 0, '排程：字典序下高层 D=0')
  assert(layerOf(r, 'low').D === 10, '排程：高层容差固定后低层 D=10')
  const enX = r.entries[1]
  const enY = r.entries[2]
  assert(enX.actualMin === T0 + 10 && enX.deviation === 0, '排程：X 精确达到期望（高层零偏差）')
  assert(enY.actualMin === T0 + 10 && enY.deviation === 10, '排程：Y 承担全部耦合代价（低层偏差 10）')
  assert(scheduleFeasible(events, cs, obs, r), '排程：字典序输出满足全部约束、观测与各层容差')
}

// ---- 分层排程：高/中/低三层独立事件各自求解 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'x', name: 'X' }, { id: 'y', name: 'Y' }, { id: 'z', name: 'Z' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'x', bId: 'a', relation: 'later', min: 0, max: 20, enabled: true },
    { id: 'c2', aId: 'y', bId: 'a', relation: 'later', min: 0, max: 8, enabled: true },
    { id: 'c3', aId: 'z', bId: 'a', relation: 'later', min: 0, max: 6, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
  ]
  const r = computeMinDeviationSchedule(
    events, cs, obs,
    { x: isoPlus(25), y: isoPlus(10), z: isoPlus(-5) },
    { x: 'high', y: 'medium', z: 'low' },
  )!
  assert(layerOf(r, 'high').D === 5, '排程：三层场景高层 D=5')
  assert(layerOf(r, 'medium').D === 2, '排程：三层场景中层 D=2')
  assert(layerOf(r, 'low').D === 5, '排程：三层场景低层 D=5')
  assert(r.desiredCount === 3, '排程：三层共 3 个期望事件')
  assert(
    r.entries[1].actualMin === T0 + 20 && r.entries[2].actualMin === T0 + 8 && r.entries[3].actualMin === T0,
    '排程：三层事件各自钉在窗口最近端点',
  )
  assert(scheduleFeasible(events, cs, obs, r), '排程：三层场景输出可行')
}

// ---- 分层排程：多观测场景下排程必须同时满足所有观测 ----
{
  // A=T0，C=T0+30（精确）；B 与 A、C 为非负链。期望 B=T0+100（中）。
  // B 被观测夹在 [T0, T0+30]，排程实际只能取该区间，D=70；且不得违反 C 的观测。
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 0, max: 1000, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 0, max: 1000, enabled: true },
  ]
  const obs: Observation[] = [
    { id: 'o1', eventId: 'a', earliest: ANCHOR_ISO, latest: ANCHOR_ISO, enabled: true },
    { id: 'o2', eventId: 'c', earliest: isoPlus(30), latest: isoPlus(30), enabled: true },
  ]
  const r = computeMinDeviationSchedule(events, cs, obs, { b: isoPlus(100) }, {})!
  const lm = layerOf(r, 'medium')
  assert(lm.D === 70, `排程：多观测夹逼下 D=70（实际 ${lm.D}）`)
  assert(r.entries[1].actualMin === T0 + 30, '排程：B 取离期望最近的可行点 T0+30（由 C 的观测决定）')
  assert(r.entries[2].actualMin === T0 + 30, '排程：C 严格等于其观测时刻')
  assert(scheduleFeasible(events, cs, obs, r), '排程：多观测场景输出满足全部观测')
}

// ---- 分层排程：区间观测内的期望可达 D=0；相同输入输出确定 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const t0 = localToEpochMin(s.observations[0].earliest)!
  const obs = s.observations.filter((o) => o.eventId === s.events[byName.get('值班告警触发')!].id)
  const desired = {
    [s.events[byName.get('服务恢复')!].id]: epochMinToLocal(t0 + 15),
    [s.events[byName.get('复盘会议')!].id]: epochMinToLocal(t0 + 120),
  }
  const prio = { [s.events[byName.get('服务恢复')!].id]: 'high' as const }
  const r = computeMinDeviationSchedule(s.events, s.constraints, obs, desired, prio)!
  assert(layerOf(r, 'high').D === 0 && layerOf(r, 'medium').D === 0, '排程：期望全部可达时各层 D=0')
  assert(
    r.entries.every((en) => en.deviation === null || en.deviation === 0),
    '排程：D=0 时全部期望偏差为 0',
  )
  assert(scheduleFeasible(s.events, s.constraints, obs, r), '排程：D=0 输出可行')

  const mk = () =>
    computeMinDeviationSchedule(
      s.events, s.constraints, obs,
      { [s.events[byName.get('服务恢复')!].id]: epochMinToLocal(t0 + 25) },
      { [s.events[byName.get('服务恢复')!].id]: 'low' },
    )
  assert(JSON.stringify(mk()) === JSON.stringify(mk()), '排程：相同输入输出确定一致')
}

// ---- 分层排程：未连通事件的期望与层级被忽略并明确标记 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const press = byName.get('媒体报道')!
  const t0 = localToEpochMin(s.observations[0].earliest)!
  const obs = s.observations.filter((o) => o.eventId === s.events[byName.get('值班告警触发')!].id)
  const r = computeMinDeviationSchedule(s.events, s.constraints, obs, {
    [s.events[byName.get('服务恢复')!].id]: epochMinToLocal(t0 + 25),
    [s.events[press].id]: epochMinToLocal(t0 + 50),
  }, { [s.events[press].id]: 'high' })!
  assert(r.desiredCount === 1, '排程：未连通事件的期望不参与搜索（仅 1 个有效期望）')
  assert(layerOf(r, 'high').count === 0, '排程：未连通事件的高层级不进入高层搜索')
  const enPress = r.entries[press]
  assert(enPress.status === 'unscheduled' && enPress.desiredIgnored, '排程：未连通事件标记未定时且期望被忽略')
  assert(enPress.desiredMin === t0 + 50, '排程：被忽略的期望仍记录时刻以便展示')
  assert(enPress.priority === 'high', '排程：被忽略的期望仍记录层级以便展示')
}

// ---- 分层排程：无可参与期望 / 前提不满足时返回 null ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const t0 = localToEpochMin(s.observations[0].earliest)!
  const obs = s.observations.filter((o) => o.eventId === s.events[0].id)
  assert(
    computeMinDeviationSchedule(s.events, s.constraints, obs, {}, {}) === null,
    '排程：未填写期望返回 null',
  )
  const pressId = s.events.find((e) => e.name === '媒体报道')!.id
  assert(
    computeMinDeviationSchedule(s.events, s.constraints, obs, { [pressId]: epochMinToLocal(t0 + 30) }, { [pressId]: 'high' }) === null,
    '排程：期望仅在未连通事件上时返回 null（即使标了高优先级）',
  )
  assert(
    computeMinDeviationSchedule(s.events, s.constraints, [], { [s.events[1].id]: isoPlus(5) }, {}) === null,
    '排程：无任何观测时返回 null',
  )
  assert(
    computeMinDeviationSchedule([], [], [], {}, {}) === null,
    '排程：空系统返回 null',
  )
  const bad = buildContradictionSample()
  assert(
    computeMinDeviationSchedule(bad.events, bad.constraints, bad.observations, {
      [bad.events[1].id]: isoPlus(15),
    }, {}) === null,
    '排程：矛盾系统返回 null（不输出旧结果）',
  )
}

// ---- 时间换算往返一致性 ----
{
  for (const m of [0, 1, 60, 24 * 60, 29915040, -100000]) {
    assert(localToEpochMin(epochMinToLocal(m)) === m, `纪元分钟 ${m} 与本地 ISO 往返一致`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
