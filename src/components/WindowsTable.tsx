import type { BoundTrace, Constraint, Observation, TEvent, WindowInfo } from '../types'
import { formatEpochMin } from '../lib/format'
import TracePanel from './TracePanel'

interface Props {
  events: TEvent[]
  windows: Map<number, WindowInfo>
  cycleEventIds: Set<string>
  /** 嵌入修复方案卡片时复用，不再渲染外层面板标题 */
  embedded?: boolean
  /** 当前展示的边界追溯（仅主时间窗表传入） */
  trace?: BoundTrace | null
  /** 追溯面板展示所需的（有效）约束与观测 */
  constraints?: Constraint[]
  observations?: Observation[]
  /** 点击某事件的最早/最晚时间：请求追溯该边界 */
  onTrace?: (eventIdx: number, kind: 'earliest' | 'latest') => void
  onCloseTrace?: () => void
}

const STATUS_META: Record<WindowInfo['status'], { label: string; cls: string; hint: string }> = {
  bounded: { label: '可定时', cls: 'bounded', hint: '最早/最晚绝对时刻均可由观测与约束推出' },
  oneSided: { label: '仅单边有界', cls: 'oneSided', hint: '只能推出最早或最晚一侧' },
  disconnected: { label: '无法定时', cls: 'disconnected', hint: '未被任何绝对时间观测连通' },
}

/** 单元格不可追溯时的原因说明 */
function noTraceReason(w: WindowInfo | undefined, kind: 'earliest' | 'latest'): string {
  const side = kind === 'earliest' ? '最早' : '最晚'
  if (!w || w.status === 'disconnected') {
    return `该事件未被任何绝对时间观测连通，无法定时，${side}边界不存在、不可追溯`
  }
  // 仅单边有界：另一侧无界
  return `该事件的${side}一侧无界：${
    kind === 'earliest' ? '反向' : '正向'
  }差分图上从时间零点不可达，没有推出该边界的观测/约束链，不可追溯`
}

export default function WindowsTable({
  events,
  windows,
  cycleEventIds,
  embedded = false,
  trace = null,
  constraints = [],
  observations = [],
  onTrace,
  onCloseTrace,
}: Props) {
  const traceable = !!onTrace

  /** 渲染最早/最晚时间单元格：有界且可追溯时为按钮，否则置灰并说明原因 */
  const renderTimeCell = (i: number, w: WindowInfo | undefined, kind: 'earliest' | 'latest') => {
    const value = kind === 'earliest' ? w?.earliestMin : w?.latestMin
    if (!w || value === null || value === undefined) {
      return (
        <span className="cell-na" title={noTraceReason(w, kind)}>
          —<span className="cell-na-icon">ⓘ</span>
        </span>
      )
    }
    const text = formatEpochMin(value)
    if (!traceable) return text
    const active = trace !== null && trace.eventIdx === i && trace.kind === kind
    return (
      <button
        type="button"
        className={`cell-btn${active ? ' active' : ''}`}
        title={
          active
            ? '再次点击关闭追溯'
            : `点击追溯：推导该${kind === 'earliest' ? '最早' : '最晚'}边界的观测/约束紧链`
        }
        onClick={() => onTrace!(i, kind)}
      >
        {text}
      </button>
    )
  }

  return (
    <div className="panel" style={embedded ? { padding: 0, border: 'none', background: 'transparent' } : undefined}>
      {!embedded && (
        <h3>
          各事件的绝对时间窗
          <span className="count">
            最早 ≤ 实际时间 ≤ 最晚（由全部观测与相对约束统一求解）{traceable && ' · 点击最早/最晚时间可追溯边界推导链'}
          </span>
        </h3>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="windows">
          <thead>
            <tr>
              <th>事件</th>
              <th>状态</th>
              <th className="num">最早时间</th>
              <th className="num">最晚时间</th>
              <th className="num">窗宽</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => {
              const w = windows.get(i)
              const meta = w ? STATUS_META[w.status] : STATUS_META.disconnected
              const inCycle = cycleEventIds.has(ev.id)
              const traced = trace !== null && trace.eventIdx === i
              const width =
                w && w.earliestMin !== null && w.latestMin !== null
                  ? `${w.latestMin - w.earliestMin} 分钟`
                  : '—'
              return (
                <tr key={ev.id} className={`${inCycle ? 'cycle' : ''}${traced ? ' traced' : ''}`}>
                  <td>
                    {ev.name}
                    {w?.observed && (
                      <span className="badge anchor" title="该事件自身录有绝对时间观测">
                        有观测
                      </span>
                    )}
                    {ev.note && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>{ev.note}</div>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${meta.cls}`} title={meta.hint}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="num">{renderTimeCell(i, w, 'earliest')}</td>
                  <td className="num">{renderTimeCell(i, w, 'latest')}</td>
                  <td className="num">{width}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 边界依据追溯面板（仅主时间窗表；修复方案卡片内嵌表格不可追溯） */}
      {!embedded && trace && onCloseTrace && (
        <TracePanel
          trace={trace}
          events={events}
          constraints={constraints}
          observations={observations}
          onClose={onCloseTrace}
        />
      )}
    </div>
  )
}
