import { useState } from 'react'
import type { TEvent } from '../types'

interface Props {
  events: TEvent[]
  anchorId: string | null
  cycleEventIds: Set<string>
  onAdd: (name: string, note: string) => void
  onRemove: (id: string) => void
  onRename: (id: string, name: string) => void
  onSetAnchor: (id: string) => void
}

export default function EventEditor({
  events,
  anchorId,
  cycleEventIds,
  onAdd,
  onRemove,
  onRename,
  onSetAnchor,
}: Props) {
  const [name, setName] = useState('')
  const [note, setNote] = useState('')

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onAdd(trimmed, note.trim())
    setName('')
    setNote('')
  }

  return (
    <div className="panel">
      <h3>
        事件
        <span className="count">{events.length} 个</span>
      </h3>

      {events.length === 0 && <div className="empty-hint">还没有事件，先添加采访 / 复盘中的关键时点。</div>}

      {events.map((ev) => (
        <div className="event-row" key={ev.id}>
          <input
            type="radio"
            name="anchor-event"
            title="设为锚点事件"
            checked={ev.id === anchorId}
            onChange={() => onSetAnchor(ev.id)}
          />
          <div className="name">
            <input
              value={ev.name}
              onChange={(e) => onRename(ev.id, e.target.value)}
              style={{ width: '100%' }}
              aria-label="事件名称"
            />
            {ev.note && <div className="note">{ev.note}</div>}
          </div>
          {ev.id === anchorId && <span className="badge anchor">锚点</span>}
          {cycleEventIds.has(ev.id) && <span className="badge cycle">矛盾环</span>}
          <button className="small danger-ghost" onClick={() => onRemove(ev.id)} title="删除事件及其相关约束">
            删除
          </button>
        </div>
      ))}

      <div className="add-row">
        <input
          className="name-input"
          placeholder="新事件名称，如：服务恢复"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <input
          placeholder="备注（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          style={{ width: 160 }}
        />
        <button className="primary" onClick={submit} disabled={!name.trim()}>
          添加事件
        </button>
      </div>
    </div>
  )
}
