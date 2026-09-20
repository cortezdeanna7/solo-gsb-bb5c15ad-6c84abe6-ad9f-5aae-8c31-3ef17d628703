import { useEffect, useMemo, useState } from 'react'
import type { AppState, Constraint, PriorityLevel, TEvent } from './types'
import { analyze, traceBound } from './lib/graph'
import { findMinimalRepairs } from './lib/repair'
import { computeMinDeviationSchedule } from './lib/schedule'
import {
  buildConsistentSample,
  buildContradictionSample,
  defaultAnchorTime,
  emptyState,
  uid,
} from './lib/samples'
import { clearState, loadState, saveState } from './lib/storage'
import { formatFullDateTime } from './lib/format'
import EventEditor from './components/EventEditor'
import ConstraintEditor from './components/ConstraintEditor'
import GraphView from './components/GraphView'
import CyclePanel from './components/CyclePanel'
import WindowsTable from './components/WindowsTable'
import RepairPanel from './components/RepairPanel'
import SchedulePanel from './components/SchedulePanel'

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? buildConsistentSample())
  // 修复方案预览：仅内存生效，不写入 localStorage；任何编辑操作都会退出预览
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  // 边界追溯请求：点击时间窗表中某事件的最早/最晚时间后设置；
  // 编辑数据、切换锚点、进入/退出修复预览时自动清除
  const [traceReq, setTraceReq] = useState<{ eventIdx: number; kind: 'earliest' | 'latest' } | null>(null)

  // 本地持久化：任何修改实时写入 localStorage（预览状态不入存储）
  useEffect(() => {
    saveState(state)
  }, [state])

  const { events, constraints, anchorId, anchorTime, desiredTimes, desiredPriorities } = state

  // —— 原始数据的实时分析（用于矛盾判定与修复搜索）——
  const result = useMemo(
    () => analyze(events, constraints, anchorId),
    [events, constraints, anchorId],
  )

  // —— 最小修复建议：仅在检测到矛盾（负环）时搜索 ——
  const repair = useMemo(
    () =>
      result.satisfiable
        ? null
        : findMinimalRepairs(events, constraints, anchorId),
    [events, constraints, anchorId, result.satisfiable],
  )

  // —— 预览中的停用集合 ——
  const previewOffIds = useMemo(() => {
    if (previewIndex === null || !repair) return null
    return new Set(repair.plans[previewIndex]?.disableConstraintIds ?? [])
  }, [previewIndex, repair])

  // —— 叠加预览后的约束与分析结果（不修改 state，因此不会写入 localStorage）——
  const effectiveConstraints = useMemo(() => {
    if (!previewOffIds) return constraints
    return constraints.map((c) =>
      previewOffIds.has(c.id) ? { ...c, enabled: false } : c,
    )
  }, [constraints, previewOffIds])

  const effectiveResult = useMemo(() => {
    if (!previewOffIds) return result
    return analyze(events, effectiveConstraints, anchorId)
  }, [events, effectiveConstraints, anchorId, previewOffIds, result])

  // —— 分层最小偏差排程：仅在有效系统可满足且已设置锚点时计算；
  //    编辑约束、锚点、期望值或优先级层级都会触发实时重算，矛盾时返回 null（不展示旧结果）——
  const anchorExists = anchorId != null && events.some((e) => e.id === anchorId)
  const schedule = useMemo(() => {
    if (!effectiveResult.satisfiable || !anchorExists) return null
    return computeMinDeviationSchedule(
      events,
      effectiveConstraints,
      anchorId,
      anchorTime,
      desiredTimes,
      desiredPriorities,
    )
  }, [effectiveResult.satisfiable, anchorExists, events, effectiveConstraints, anchorId, anchorTime, desiredTimes, desiredPriorities])

  // 矛盾环相关集合（用于跨组件高亮；预览可满足时为空）
  const cycleEventIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const i of effectiveResult.cycle.nodes) if (events[i]) s.add(events[i].id)
    }
    return s
  }, [effectiveResult, events])

  const cycleConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) s.add(e.constraintId)
    }
    return s
  }, [effectiveResult])

  const cycleEdgeIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) s.add(`${e.constraintId}:${e.bound}`)
    }
    return s
  }, [effectiveResult])

  const cycleNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle)
      for (const i of effectiveResult.cycle.nodes) s.add(i)
    return s
  }, [effectiveResult])

  // —— 边界依据追溯：按当前有效约束（含修复预览）重新计算紧约束链 ——
  const trace = useMemo(() => {
    if (!traceReq || !anchorId || !effectiveResult.satisfiable) return null
    return traceBound(events, effectiveConstraints, anchorId, traceReq.eventIdx, traceReq.kind)
  }, [traceReq, events, effectiveConstraints, anchorId, effectiveResult.satisfiable])

  const traceEdgeIds = useMemo(() => {
    const s = new Set<string>()
    if (trace) for (const st of trace.steps) s.add(`${st.edge.constraintId}:${st.edge.bound}`)
    return s
  }, [trace])

  const traceNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (trace) {
      s.add(trace.eventIdx)
      const ai = events.findIndex((e) => e.id === anchorId)
      if (ai >= 0) s.add(ai)
      for (const st of trace.steps) {
        s.add(st.from)
        s.add(st.to)
      }
    }
    return s
  }, [trace, events, anchorId])

  const traceConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (trace) for (const st of trace.steps) s.add(st.edge.constraintId)
    return s
  }, [trace])

  /** 点击时间窗单元格：再次点击同一单元格则关闭追溯 */
  const requestTrace = (eventIdx: number, kind: 'earliest' | 'latest') => {
    setTraceReq((cur) =>
      cur && cur.eventIdx === eventIdx && cur.kind === kind ? null : { eventIdx, kind },
    )
  }

  const activeCount = constraints.filter((c) => c.enabled).length
  const previewing = previewOffIds !== null

  // —— 编辑操作（均退出预览并清除边界追溯，避免预览/追溯与新数据错位）——
  const addEvent = (name: string, note: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    const ev: TEvent = { id: uid('ev'), name, note: note || undefined }
    setState((s) => ({
      ...s,
      events: [...s.events, ev],
      anchorId: s.anchorId ?? ev.id,
    }))
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
        anchorId: s.anchorId === id ? null : s.anchorId,
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

  const setAnchor = (id: string) => {
    // 切换锚点后旧的推导链不再适用，清除追溯
    setTraceReq(null)
    setState((s) => ({ ...s, anchorId: id }))
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
    if (!window.confirm('确定清空全部事件、约束与本地存储数据吗？')) return
    setPreviewIndex(null)
    setTraceReq(null)
    clearState()
    setState(emptyState())
  }

  // —— 修复方案：预览 / 确认应用 ——
  const previewRepair = (i: number) => {
    // 进入预览后按有效约束重新计算，旧追溯一律清除
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
    const off = new Set(plan.disableConstraintIds)
    setPreviewIndex(null)
    setTraceReq(null)
    // 确认后批量停用对应约束（state 变更即写入 localStorage）
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) =>
        off.has(c.id) ? { ...c, enabled: false } : c,
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
        desc: '添加事件并指定锚点后开始分析。也可以直接载入下方示例数据。',
      }
    }
    if (!effectiveResult.satisfiable) {
      return {
        cls: 'danger',
        icon: '⛔',
        title: '约束相互矛盾，不存在任何可行的事件时间安排',
        desc: `差分约束图中检测到负环（环上权重之和为 ${effectiveResult.cycle?.totalWeight} 分钟 < 0）。红色标出的环即一条可复核的矛盾链：请核对对应证词或记录；下方同时给出停用约束最少的修复建议。`,
      }
    }
    if (previewing) {
      return {
        cls: 'ok',
        icon: '👁️',
        title: '修复预览：停用建议中的约束后，系统恢复可满足',
        desc: '当前为临时预览，停用尚未写入浏览器本地存储；确认无误后请在方案卡片上点击“确认应用”，或退出预览返回原数据。',
      }
    }
    if (!anchorExists) {
      return {
        cls: 'warn',
        icon: '🎯',
        title: '约束系统本身一致，但尚未指定锚点事件',
        desc: '在事件列表中点选单选按钮指定锚点，并设置锚点绝对时间，即可得到各事件的最早 / 最晚时间窗。',
      }
    }
    return {
      cls: 'ok',
      icon: '✅',
      title: '约束可满足：存在与全部约束相容的时间安排',
      desc: `共 ${events.length} 个事件、${activeCount} 条生效约束。下表给出每个事件相对锚点的最早与最晚时间；与锚点无约束通路的事件标记为“无法定时”。`,
    }
  })()

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>事件时序约束校验器</h1>
          <div className="subtitle">
            采访证词 / 事故复盘 · 差分约束图（Difference Constraints）实时可满足性判定
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

      {/* 锚点 */}
      <div className="anchor-bar">
        <label className="title">锚点</label>
        <select
          value={anchorId ?? ''}
          onChange={(e) => setAnchor(e.target.value)}
          aria-label="锚点事件"
        >
          <option value="">（未选择）</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <label className="title" style={{ fontWeight: 400 }}>
          锚点绝对时间
        </label>
        <input
          type="datetime-local"
          value={anchorTime}
          onChange={(e) => {
            // 锚点时间也属于编辑：清除旧追溯（偏移链不变，但避免展示过期结论）
            setTraceReq(null)
            setState((s) => ({ ...s, anchorTime: e.target.value || defaultAnchorTime() }))
          }}
        />
        <span className="anchor-absolute">= {formatFullDateTime(anchorTime)}</span>
      </div>

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
            />
          )}
        </div>
      </div>

      {/* 修复预览提示条（预览不写入 localStorage） */}
      {previewing && (
        <div className="preview-bar">
          <span>
            👁️ 正在<strong>预览修复方案 {previewIndex! + 1}</strong>
            ：已临时停用 {previewOffIds!.size} 条约束（约束列表中置灰并标记“预览停用”），
            本预览<strong>不会写入 localStorage</strong>。
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
            repair={repair}
            anchorId={anchorId}
            anchorTime={anchorTime}
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
          <span className="count">边标签 w 表示 t终点 − t起点 ≤ w（分钟）</span>
        </h3>
        <GraphView
          events={events}
          constraints={effectiveConstraints}
          anchorId={anchorId}
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
          anchorId={anchorId}
          cycleEventIds={cycleEventIds}
          onAdd={addEvent}
          onRemove={removeEvent}
          onRename={renameEvent}
          onSetAnchor={setAnchor}
        />
        <ConstraintEditor
          events={events}
          constraints={effectiveConstraints}
          cycleConstraintIds={cycleConstraintIds}
          traceConstraintIds={traceConstraintIds}
          previewOffIds={previewOffIds}
          onAdd={addConstraint}
          onRemove={removeConstraint}
          onUpdate={updateConstraint}
        />
      </div>

      {/* 时间窗（预览时展示修复后的窗口；正常可满足时展示当前窗口） */}
      {effectiveResult.satisfiable && (
        <WindowsTable
          events={events}
          windows={effectiveResult.windows}
          cycleEventIds={cycleEventIds}
          anchorId={anchorId}
          anchorTime={anchorTime}
          trace={trace}
          constraints={effectiveConstraints}
          onTrace={requestTrace}
          onCloseTrace={() => setTraceReq(null)}
        />
      )}

      {/* 分层最小偏差排程：期望时刻与优先级填写 + 高→中→低字典序搜索得到的可行排程 */}
      <div style={{ marginTop: 16 }}>
        <SchedulePanel
          events={events}
          anchorId={anchorId}
          anchorTime={anchorTime}
          desiredTimes={desiredTimes}
          desiredPriorities={desiredPriorities}
          satisfiable={effectiveResult.satisfiable}
          anchorExists={anchorExists}
          windows={effectiveResult.windows}
          schedule={schedule}
          onDesiredChange={setDesiredTime}
          onPriorityChange={setDesiredPriority}
        />
      </div>

      <div className="footer-note">
        数据自动保存在浏览器 localStorage，刷新不丢失 · 停用某条约束可即时验证“去掉该证词后矛盾是否消除” ·
        修复方案的“一键预览”仅在内存生效，点击“确认应用”才会批量停用并写入本地存储 ·
        期望时刻与优先级层级随项目一同持久化，编辑约束、锚点、期望值或层级后分层最小偏差排程实时重算
      </div>
    </div>
  )
}
