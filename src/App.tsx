import { useEffect, useMemo, useState } from 'react'
import type { AppState, Constraint, Observation, PriorityLevel, TEvent } from './types'
import { analyze, edgeKey, traceBound } from './lib/graph'
import { findMinimalRepairs } from './lib/repair'
import { computeMinDeviationSchedule } from './lib/schedule'
import {
  buildConsistentSample,
  buildContradictionSample,
  emptyState,
  uid,
} from './lib/samples'
import { clearState, loadState, saveState } from './lib/storage'
import EventEditor from './components/EventEditor'
import ConstraintEditor from './components/ConstraintEditor'
import ObservationEditor from './components/ObservationEditor'
import GraphView from './components/GraphView'
import CyclePanel from './components/CyclePanel'
import WindowsTable from './components/WindowsTable'
import RepairPanel from './components/RepairPanel'
import SchedulePanel from './components/SchedulePanel'

interface PreviewOff {
  constraintIds: Set<string>
  observationIds: Set<string>
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? buildConsistentSample())
  // 修复方案预览：仅内存生效，不写入 localStorage；任何编辑操作都会退出预览
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  // 边界追溯请求：点击时间窗表中某事件的最早/最晚时间后设置；
  // 编辑数据、进入/退出修复预览时自动清除
  const [traceReq, setTraceReq] = useState<{ eventIdx: number; kind: 'earliest' | 'latest' } | null>(null)

  // 本地持久化：任何修改实时写入 localStorage（预览状态不入存储）
  useEffect(() => {
    saveState(state)
  }, [state])

  const { events, constraints, observations, desiredTimes, desiredPriorities } = state

  // —— 原始数据的实时分析（相对约束 + 绝对观测同图，用于矛盾判定与修复搜索）——
  const result = useMemo(
    () => analyze(events, constraints, observations),
    [events, constraints, observations],
  )

  // —— 最小修复建议：仅在检测到矛盾（负环）时搜索 ——
  const repair = useMemo(
    () =>
      result.satisfiable
        ? null
        : findMinimalRepairs(events, constraints, observations),
    [events, constraints, observations, result.satisfiable],
  )

  // —— 预览中的停用集合 ——
  const previewOff: PreviewOff | null = useMemo(() => {
    if (previewIndex === null || !repair) return null
    const plan = repair.plans[previewIndex]
    if (!plan) return null
    return {
      constraintIds: new Set(
        plan.disableItems.filter((d) => d.origin === 'constraint').map((d) => d.sourceId),
      ),
      observationIds: new Set(
        plan.disableItems.filter((d) => d.origin === 'observation').map((d) => d.sourceId),
      ),
    }
  }, [previewIndex, repair])

  // —— 叠加预览后的约束/观测与分析结果（不修改 state，因此不会写入 localStorage）——
  const effectiveConstraints = useMemo(() => {
    if (!previewOff) return constraints
    return constraints.map((c) =>
      previewOff.constraintIds.has(c.id) ? { ...c, enabled: false } : c,
    )
  }, [constraints, previewOff])

  const effectiveObservations = useMemo(() => {
    if (!previewOff) return observations
    return observations.map((o) =>
      previewOff.observationIds.has(o.id) ? { ...o, enabled: false } : o,
    )
  }, [observations, previewOff])

  const effectiveResult = useMemo(() => {
    if (!previewOff) return result
    return analyze(events, effectiveConstraints, effectiveObservations)
  }, [events, effectiveConstraints, effectiveObservations, previewOff, result])

  const hasObservations = effectiveResult.clockIdx !== null
  const previewing = previewOff !== null

  // —— 分层最小偏差排程：仅在有效系统可满足且存在观测（绝对基准）时计算；
  //    编辑约束、观测、期望值或优先级都会触发实时重算，矛盾时返回 null（不展示旧结果）——
  const schedule = useMemo(() => {
    if (!effectiveResult.satisfiable || !hasObservations) return null
    return computeMinDeviationSchedule(
      events,
      effectiveConstraints,
      effectiveObservations,
      desiredTimes,
      desiredPriorities,
    )
  }, [effectiveResult.satisfiable, hasObservations, events, effectiveConstraints, effectiveObservations, desiredTimes, desiredPriorities])

  // 矛盾链相关集合（用于跨组件高亮；预览可满足时为空）
  const cycleEventIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const i of effectiveResult.cycle.nodes) {
        if (events[i]) s.add(events[i].id)
      }
    }
    return s
  }, [effectiveResult, events])

  const cycleConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) {
        if (e.origin === 'constraint') s.add(e.sourceId)
      }
    }
    return s
  }, [effectiveResult])

  const cycleObservationIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) {
        if (e.origin === 'observation') s.add(e.sourceId)
      }
    }
    return s
  }, [effectiveResult])

  const cycleEdgeIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) s.add(edgeKey(e))
    }
    return s
  }, [effectiveResult])

  const cycleNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle)
      for (const i of effectiveResult.cycle.nodes) s.add(i)
    return s
  }, [effectiveResult])

  // 录有有效观测的事件（用于事件列表徽章）
  const observedEventIds = useMemo(() => {
    const s = new Set<string>()
    if (effectiveResult.clockIdx !== null) {
      for (const [i, w] of effectiveResult.windows) {
        if (w.observed && events[i]) s.add(events[i].id)
      }
    }
    return s
  }, [effectiveResult, events])

  // —— 边界依据追溯：按当前有效约束与观测（含修复预览）重新计算紧约束链 ——
  const trace = useMemo(() => {
    if (!traceReq || !effectiveResult.satisfiable) return null
    return traceBound(
      events,
      effectiveConstraints,
      effectiveObservations,
      traceReq.eventIdx,
      traceReq.kind,
    )
  }, [traceReq, events, effectiveConstraints, effectiveObservations, effectiveResult.satisfiable])

  const traceEdgeIds = useMemo(() => {
    const s = new Set<string>()
    if (trace) for (const st of trace.steps) s.add(edgeKey(st.edge))
    return s
  }, [trace])

  const traceNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (trace) {
      s.add(trace.eventIdx)
      s.add(trace.clockIdx)
      for (const st of trace.steps) {
        s.add(st.from)
        s.add(st.to)
      }
    }
    return s
  }, [trace])

  const traceConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (trace) {
      for (const st of trace.steps) if (st.edge.origin === 'constraint') s.add(st.edge.sourceId)
    }
    return s
  }, [trace])

  const traceObservationIds = useMemo(() => {
    const s = new Set<string>()
    if (trace) {
      for (const st of trace.steps) if (st.edge.origin === 'observation') s.add(st.edge.sourceId)
    }
    return s
  }, [trace])

  /** 点击时间窗单元格：再次点击同一单元格则关闭追溯 */
  const requestTrace = (eventIdx: number, kind: 'earliest' | 'latest') => {
    setTraceReq((cur) =>
      cur && cur.eventIdx === eventIdx && cur.kind === kind ? null : { eventIdx, kind },
    )
  }

  const activeCount = constraints.filter((c) => c.enabled).length
  const activeObsCount = observations.filter((o) => o.enabled).length

  // —— 编辑操作（均退出预览并清除边界追溯，避免预览/追溯与新数据错位）——
  const addEvent = (name: string, note: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    const ev: TEvent = { id: uid('ev'), name, note: note || undefined }
    setState((s) => ({ ...s, events: [...s.events, ev] }))
  }

  const removeEvent = (id: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => {
      const desiredTimes = { ...s.desiredTimes }
      delete desiredTimes[id]
      const desiredPriorities = { ...s.desiredPriorities }
      delete desiredPriorities[id]
      return {
        ...s,
        events: s.events.filter((e) => e.id !== id),
        constraints: s.constraints.filter((c) => c.aId !== id && c.bId !== id),
        observations: s.observations.filter((o) => o.eventId !== id),
        desiredTimes,
        desiredPriorities,
      }
    })
  }

  const renameEvent = (id: string, name: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      events: s.events.map((e) => (e.id === id ? { ...e, name } : e)),
    }))
  }

  const addConstraint = (c: Omit<Constraint, 'id'>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, constraints: [...s.constraints, { ...c, id: uid('ct') }] }))
  }

  const removeConstraint = (id: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, constraints: s.constraints.filter((c) => c.id !== id) }))
  }

  const updateConstraint = (id: string, patch: Partial<Constraint>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) => {
        if (c.id !== id) return c
        const next = { ...c, ...patch }
        // 防止输入过程中出现 min > max / 负数
        if (!Number.isFinite(next.min) || next.min < 0) next.min = 0
        if (!Number.isFinite(next.max) || next.max < next.min) next.max = next.min
        if (Number.isFinite(next.min) && next.min > next.max) next.min = next.max
        return next
      }),
    }))
  }

  // —— 观测：新增 / 编辑 / 删除，实时重算并持久化 ——
  const addObservation = (o: Omit<Observation, 'id'>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, observations: [...s.observations, { ...o, id: uid('obs') }] }))
  }

  const removeObservation = (id: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, observations: s.observations.filter((o) => o.id !== id) }))
  }

  const updateObservation = (id: string, patch: Partial<Observation>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      observations: s.observations.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    }))
  }

  // 填写 / 清除某事件的期望时刻（与其他编辑一样退出预览并清除追溯，随后自动重算排程）；
  // 清除期望时刻时一并移除其优先级层级
  const setDesiredTime = (id: string, iso: string | null) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => {
      const desiredTimes = { ...s.desiredTimes }
      const desiredPriorities = { ...s.desiredPriorities }
      if (iso) desiredTimes[id] = iso
      else {
        delete desiredTimes[id]
        delete desiredPriorities[id]
      }
      return { ...s, desiredTimes, desiredPriorities }
    })
  }

  // 设置某事件期望时刻的优先级层级（高/中/低）；与其他编辑一样触发实时重算
  const setDesiredPriority = (id: string, level: PriorityLevel) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      desiredPriorities: { ...s.desiredPriorities, [id]: level },
    }))
  }

  const loadSample = (kind: 'ok' | 'conflict') => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState(kind === 'ok' ? buildConsistentSample() : buildContradictionSample())
  }

  const resetAll = () => {
    if (!window.confirm('确定清空全部事件、约束、观测与本地存储数据吗？')) return
    setPreviewIndex(null)
    setTraceReq(null)
    clearState()
    setState(emptyState())
  }

  // —— 修复方案：预览 / 确认应用 ——
  const previewRepair = (i: number) => {
    // 进入预览后按有效条目重新计算，旧追溯一律清除
    setTraceReq(null)
    setPreviewIndex(i)
  }
  const exitPreview = () => {
    setTraceReq(null)
    setPreviewIndex(null)
  }
  const applyRepair = (i: number) => {
    if (!repair) return
    const plan = repair.plans[i]
    if (!plan) return
    const offConstraints = new Set(
      plan.disableItems.filter((d) => d.origin === 'constraint').map((d) => d.sourceId),
    )
    const offObservations = new Set(
      plan.disableItems.filter((d) => d.origin === 'observation').map((d) => d.sourceId),
    )
    setPreviewIndex(null)
    setTraceReq(null)
    // 确认后批量停用对应约束/观测（state 变更即写入 localStorage）
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) =>
        offConstraints.has(c.id) ? { ...c, enabled: false } : c,
      ),
      observations: s.observations.map((o) =>
        offObservations.has(o.id) ? { ...o, enabled: false } : o,
      ),
    }))
  }

  // —— 顶部状态 ——
  const banner = (() => {
    if (events.length === 0) {
      return {
        cls: 'warn',
        icon: '📋',
        title: '等待录入',
        desc: '添加事件并录入至少一条绝对时间观测后开始分析。也可以直接载入下方示例数据。',
      }
    }
    if (!effectiveResult.satisfiable) {
      return {
        cls: 'danger',
        icon: '⛔',
        title: '观测与约束相互矛盾，不存在任何可行的事件时间安排',
        desc: `统一差分约束图中检测到负权环（环上权重之和为 ${effectiveResult.cycle?.totalWeight} 分钟 < 0）。红色标出的矛盾链同时引用涉及的绝对观测与原始相对约束，可逐步复核；下方同时给出停用条目最少的修复建议。`,
      }
    }
    if (previewing) {
      return {
        cls: 'ok',
        icon: '👁️',
        title: '修复预览：停用建议中的约束/观测后，系统恢复可满足',
        desc: '当前为临时预览，停用尚未写入浏览器本地存储；确认无误后请在方案卡片上点击“确认应用”，或退出预览返回原数据。',
      }
    }
    if (!hasObservations) {
      return {
        cls: 'warn',
        icon: '🎯',
        title: '相对约束系统本身一致，但尚无生效的绝对时间观测',
        desc: '在「绝对时间观测」面板为事件录入精确时刻或观测区间（可多条），即可统一求解各事件的绝对时间窗。',
      }
    }
    return {
      cls: 'ok',
      icon: '✅',
      title: '观测与约束可满足：存在与全部观测、约束相容的时间安排',
      desc: `共 ${events.length} 个事件、${activeCount} 条生效相对约束、${activeObsCount} 条生效观测。下表给出每个事件的绝对时间窗；未被任何观测连通的事件标记为“无法定时”。`,
    }
  })()

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>事件时序约束校验器</h1>
          <div className="subtitle">
            采访证词 / 事故复盘 · 多观测区间 + 相对约束统一差分图（Difference Constraints）实时可满足性判定
          </div>
        </div>
        <div className="toolbar">
          <button onClick={() => loadSample('ok')}>载入可满足示例</button>
          <button onClick={() => loadSample('conflict')}>载入矛盾示例</button>
          <button className="danger-ghost" onClick={resetAll}>
            清空全部数据
          </button>
        </div>
      </header>

      {/* 判定横幅 */}
      <div className={`status-banner ${banner.cls}`}>
        <div className="icon">{banner.icon}</div>
        <div>
          <h2>{banner.title}</h2>
          <p>{banner.desc}</p>
          {!effectiveResult.satisfiable && effectiveResult.cycle && (
            <CyclePanel
              cycle={effectiveResult.cycle}
              events={events}
              constraints={effectiveConstraints}
              observations={effectiveObservations}
              clockIdx={effectiveResult.clockIdx}
            />
          )}
        </div>
      </div>

      {/* 修复预览提示条（预览不写入 localStorage） */}
      {previewing && previewOff && (
        <div className="preview-bar">
          <span>
            👁️ 正在<strong>预览修复方案 {previewIndex! + 1}</strong>
            ：已临时停用 {previewOff.constraintIds.size} 条约束、{previewOff.observationIds.size} 条观测
            （列表中置灰并标记“预览停用”），本预览<strong>不会写入 localStorage</strong>。
          </span>
          <button className="small" onClick={exitPreview}>
            退出预览
          </button>
        </div>
      )}

      {/* 最小修复建议（仅原始数据存在矛盾时搜索并展示） */}
      {!result.satisfiable && repair && (
        <div style={{ marginBottom: 16 }}>
          <RepairPanel
            events={events}
            constraints={constraints}
            observations={observations}
            repair={repair}
            previewIndex={previewIndex}
            onPreview={previewRepair}
            onExitPreview={exitPreview}
            onApply={applyRepair}
          />
        </div>
      )}

      {/* 差分图 */}
      <div className="panel graph-panel" style={{ marginBottom: 16 }}>
        <h3>
          差分约束图
          <span className="count">
            边标签 w 表示 t终点 − t起点 ≤ w（分钟）；观测边为虚线，连至圆心“绝对时间零点”
          </span>
        </h3>
        <GraphView
          events={events}
          constraints={effectiveConstraints}
          observations={effectiveObservations}
          cycleNodes={cycleNodeIdx}
          cycleEdgeIds={cycleEdgeIds}
          traceNodes={traceNodeIdx}
          traceEdgeIds={traceEdgeIds}
        />
      </div>

      {/* 编辑器 */}
      <div className="grid-2">
        <EventEditor
          events={events}
          observedEventIds={observedEventIds}
          cycleEventIds={cycleEventIds}
          onAdd={addEvent}
          onRemove={removeEvent}
          onRename={renameEvent}
        />
        <ConstraintEditor
          events={events}
          constraints={effectiveConstraints}
          cycleConstraintIds={cycleConstraintIds}
          traceConstraintIds={traceConstraintIds}
          previewOffIds={previewOff?.constraintIds ?? null}
          onAdd={addConstraint}
          onRemove={removeConstraint}
          onUpdate={updateConstraint}
        />
      </div>

      {/* 绝对时间观测（新增/编辑/删除实时重算并持久化） */}
      <div style={{ marginTop: 16 }}>
        <ObservationEditor
          events={events}
          observations={effectiveObservations}
          cycleObservationIds={cycleObservationIds}
          traceObservationIds={traceObservationIds}
          previewOffIds={previewOff?.observationIds ?? null}
          onAdd={addObservation}
          onRemove={removeObservation}
          onUpdate={updateObservation}
        />
      </div>

      {/* 时间窗（预览时展示修复后的窗口；正常可满足时展示当前窗口） */}
      {effectiveResult.satisfiable && (
        <div style={{ marginTop: 16 }}>
          <WindowsTable
            events={events}
            windows={effectiveResult.windows}
            cycleEventIds={cycleEventIds}
            trace={trace}
            constraints={effectiveConstraints}
            observations={effectiveObservations}
            onTrace={requestTrace}
            onCloseTrace={() => setTraceReq(null)}
          />
        </div>
      )}

      {/* 分层最小偏差排程：期望时刻与优先级填写 + 高→中→低字典序搜索得到的可行排程 */}
      <div style={{ marginTop: 16 }}>
        <SchedulePanel
          events={events}
          desiredTimes={desiredTimes}
          desiredPriorities={desiredPriorities}
          satisfiable={effectiveResult.satisfiable}
          hasObservations={hasObservations}
          windows={effectiveResult.windows}
          schedule={schedule}
          onDesiredChange={setDesiredTime}
          onPriorityChange={setDesiredPriority}
        />
      </div>

      <div className="footer-note">
        数据自动保存在浏览器 localStorage，刷新不丢失 · 旧版单锚点存档打开时自动迁移为一条精确观测 ·
        停用某条约束或观测可即时验证“去掉该证词/记录后矛盾是否消除” ·
        修复方案的“一键预览”仅在内存生效，点击“确认应用”才会批量停用并写入本地存储 ·
        观测、期望时刻与优先级层级随项目一同持久化，任何编辑都实时重算
      </div>
    </div>
  )
}
