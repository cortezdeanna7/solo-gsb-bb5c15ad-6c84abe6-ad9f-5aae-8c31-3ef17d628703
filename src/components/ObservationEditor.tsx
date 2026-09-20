import { useState } from 'react'
import type { Observation, TEvent } from '../types'
import { describeObservation } from '../lib/format'

interface Props {
  events: TEvent[]
  observations: Observation[]
  /** 矛盾链上的观测 id（红色高亮） */
  cycleObservationIds: Set<string>
  /** 边界追溯链上的观测 id（紫色高亮） */
  traceObservationIds?: Set<string>
  /** 修复预览中临时停用的观测 id（不写入 localStorage） */
  previewOffIds?: Set<string> | null
  onAdd: (o: Omit<Observation, 'id'>) => void
  onRemove: (id: string) => void
  onUpdate: (id: string, patch: Partial<Observation>) => void
}

/**
 * 绝对时间观测编辑器：可为任意事件录入多条观测区间
 * [最早时刻, 最晚时刻]，两端相等即为精确时刻（零宽区间）。
 * 所有观测与相对约束进入同一张差分图统一求解；
 * 观测的新增 / 编辑 / 停用 / 删除都会实时重算并持久化。
 */
export default function ObservationEditor({
  events,
  observations,
  cycleObservationIds,
  traceObservationIds,
  previewOffIds,
  onAdd,
  onRemove,
  onUpdate,
}: Props) {
  const [eventId, setEventId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const nameOf = (id: string) => events.find((e) => e.id === id)?.name ?? '（已删除事件）'

  const startValid = !!start && !Number.isNaN(new Date(start).getTime())
  // 最晚时刻留空时按精确时刻处理（零宽区间）
  const rangeValid = startValid && (!end || new Date(start).getTime() <= new Date(end).getTime())
  const canAdd = events.length >= 1 && !!eventId && rangeValid

  const submit = () => {
    if (!canAdd) return
    onAdd({ eventId, earliest: start, latest: end || start, enabled: true })
    setStart('')
    setEnd('')
  }

  return (
    <div className="panel">
      <h3>
        绝对时间观测
        <span className="count">
          {observations.filter((o) => o.enabled).length}/{observations.length} 条生效 ·
          两端填同一时刻即为精确观测
        </span>
      </h3>

      {events.length === 0 && <div className="empty-hint">先添加事件，再录入绝对时间观测。</div>}

      {events.length > 0 && observations.length === 0 && (
        <div className="empty-hint">
          还没有观测。录入至少一条观测后，系统才能给出各事件的绝对时间窗；
          未被任何观测连通的事件仍标记为“无法定时”。
        </div>
      )}

      {observations.map((o) => {
        const inCycle = cycleObservationIds.has(o.id)
        const inTrace = traceObservationIds?.has(o.id) ?? false
        const previewOff = previewOffIds?.has(o.id) ?? false
        const exact = o.earliest === o.latest
        const invalid =
          !o.earliest ||
          !o.latest ||
          new Date(o.earliest).getTime() > new Date(o.latest).getTime()
        return (
          <div
            key={o.id}
            className={`constraint-row obs-row${inCycle ? ' in-cycle' : ''}${inTrace ? ' in-trace' : ''}${o.enabled && !previewOff ? '' : ' disabled'}${previewOff ? ' preview-off' : ''}`}
          >
            <div className="constraint-editors">
              <input
                type="checkbox"
                checked={o.enabled}
                disabled={previewOff}
                onChange={(e) => onUpdate(o.id, { enabled: e.target.checked })}
                title={previewOff ? '修复预览中临时停用（未保存）' : '启用 / 停用该观测'}
              />
              <select
                value={o.eventId}
                onChange={(e) => onUpdate(o.id, { eventId: e.target.value })}
                aria-label="观测事件"
              >
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <input
                type="datetime-local"
                value={o.earliest}
                onChange={(e) => onUpdate(o.id, { earliest: e.target.value })}
                aria-label="观测最早时刻"
                className={invalid ? 'invalid' : ''}
              />
              <span className="sep">~</span>
              <input
                type="datetime-local"
                value={o.latest}
                onChange={(e) => onUpdate(o.id, { latest: e.target.value })}
                aria-label="观测最晚时刻"
                className={invalid ? 'invalid' : ''}
              />
              <button className="small danger-ghost" onClick={() => onRemove(o.id)}>
                删除
              </button>
            </div>
            <div className="constraint-text">
              {invalid
                ? '⚠️ 观测无效：最早时刻不能晚于最晚时刻（该条不参与计算）'
                : describeObservation(o, nameOf(o.eventId))}
              {exact && !invalid && '（精确时刻 · 零宽区间）'}
              {inCycle && '　← 属于矛盾链'}
              {inTrace && '　← 属于边界追溯链'}
              {previewOff && '　← 预览停用（未保存）'}
            </div>
          </div>
        )
      })}

      {events.length > 0 && (
        <div className="add-row">
          <select value={eventId} onChange={(e) => setEventId(e.target.value)} aria-label="新观测事件">
            <option value="">选择事件…</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            aria-label="新观测最早时刻"
          />
          <span className="sep">~</span>
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            aria-label="新观测最晚时刻"
          />
          <button
            className="primary"
            onClick={submit}
            disabled={!canAdd}
            title={!eventId ? '请选择事件' : !rangeValid ? '最早时刻不能晚于最晚时刻' : ''}
          >
            添加观测
          </button>
        </div>
      )}
    </div>
  )
}
