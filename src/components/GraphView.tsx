import { useMemo } from 'react'
import type { Constraint, DiffEdge, Observation, TEvent } from '../types'
import { buildEdges } from '../lib/graph'

interface Props {
  events: TEvent[]
  constraints: Constraint[]
  observations?: Observation[]
  cycleNodes: Set<number>
  cycleEdgeIds: Set<string> // "origin:sourceId:bound"
  /** 边界追溯链上的节点（含时间零点与目标事件） */
  traceNodes?: Set<number>
  /** 边界追溯链上的边，键同 cycleEdgeIds */
  traceEdgeIds?: Set<string>
}

const W = 760
const H = 500
const CX = W / 2
const CY = H / 2
const R = 180
const NODE_R = 26

/** 事件节点沿圆周布局；时间零点固定在圆心 */
function nodePos(i: number, n: number, clockIdx: number | null): { x: number; y: number } {
  if (clockIdx !== null && i === clockIdx) return { x: CX, y: CY }
  if (n <= 1) return { x: CX, y: CY }
  const count = clockIdx === null ? n : n - 1
  const ordinal = clockIdx === null ? i : i > clockIdx ? i - 1 : i
  if (count === 1) return { x: CX, y: CY - 60 }
  const ang = -Math.PI / 2 + (2 * Math.PI * ordinal) / count
  return { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) }
}

interface Arc {
  edge: DiffEdge
  path: string
  lx: number
  ly: number
  inCycle: boolean
  inTrace: boolean
}

/**
 * 差分约束图可视化：环形布局，边 u -> v 标注权重 w（表示 t_v - t_u <= w）。
 * 圆心菱形为虚拟“绝对时间零点”，观测边连到该节点；
 * 矛盾链上的节点与边以红色突出显示；边界追溯链以紫色突出显示。
 */
export default function GraphView({
  events,
  constraints,
  observations = [],
  cycleNodes,
  cycleEdgeIds,
  traceNodes,
  traceEdgeIds,
}: Props) {
  const { edges, clockIdx } = useMemo(
    () => buildEdges(events, constraints, observations),
    [events, constraints, observations],
  )
  const n = clockIdx === null ? events.length : clockIdx + 1

  const arcs = useMemo<Arc[]>(() => {
    // 同一对端点（无序）间的多条边分摊曲率，使正/反向弧彼此错开
    const pairCount = new Map<string, number>()
    const pairSeen = new Map<string, number>()

    return edges.map((edge) => {
      const p1 = nodePos(edge.u, n, clockIdx)
      const p2 = nodePos(edge.v, n, clockIdx)
      const unordered = [edge.u, edge.v].sort((a, b) => a - b).join(':')
      pairCount.set(unordered, (pairCount.get(unordered) ?? 0) + 1)
      const ord = pairSeen.get(unordered) ?? 0
      pairSeen.set(unordered, ord + 1)

      const { path, lx, ly } = arcPath(p1, p2, edge.u === edge.v, ord, pairCount.get(unordered) ?? 1)
      const key = `${edge.origin}:${edge.sourceId}:${edge.bound}`
      return {
        edge,
        path,
        lx,
        ly,
        inCycle: cycleEdgeIds.has(key),
        inTrace: traceEdgeIds?.has(key) ?? false,
      }
    })
  }, [edges, n, clockIdx, cycleEdgeIds, traceEdgeIds])

  if (events.length === 0) {
    return <div className="graph-empty">添加事件后，这里将展示差分约束图</div>
  }

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="差分约束有向图">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#7d92a6" />
          </marker>
          <marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f85149" />
          </marker>
          <marker id="arrow-trace" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#bc8cff" />
          </marker>
        </defs>

        {arcs.map((a, i) => (
          <g key={i}>
            <path
              d={a.path}
              fill="none"
              stroke={a.inCycle ? '#f85149' : a.inTrace ? '#bc8cff' : '#5b7186'}
              strokeWidth={a.inCycle || a.inTrace ? 2.6 : 1.3}
              strokeDasharray={a.edge.origin === 'observation' && !a.inCycle && !a.inTrace ? '6 3' : undefined}
              markerEnd={a.inCycle ? 'url(#arrow-cycle)' : a.inTrace ? 'url(#arrow-trace)' : 'url(#arrow)'}
              opacity={a.inCycle || a.inTrace ? 1 : 0.85}
            />
            <text
              x={a.lx}
              y={a.ly}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="11"
              fontFamily="ui-monospace, monospace"
              fill={a.inCycle ? '#ff8f8a' : a.inTrace ? '#d2a8ff' : '#8da2b5'}
              stroke="#1a212b"
              strokeWidth="3.5"
              paintOrder="stroke"
            >
              {a.edge.origin === 'observation'
                ? (a.edge.bound === 'upper' ? '≤' : '≥')
                : a.edge.w > 0 ? `+${a.edge.w}` : `${a.edge.w}`}
            </text>
          </g>
        ))}

        {/* 事件节点 */}
        {events.map((ev, i) => {
          const { x, y } = nodePos(i, n, clockIdx)
          const inCycle = cycleNodes.has(i)
          const inTrace = traceNodes?.has(i) ?? false
          const fill = inCycle ? '#3d1f22' : inTrace ? '#2d2440' : '#222c38'
          const stroke = inCycle ? '#f85149' : inTrace ? '#bc8cff' : '#46586b'
          const emphasized = inCycle || inTrace
          const label = ev.name.length > 6 ? `${ev.name.slice(0, 5)}…` : ev.name
          return (
            <g key={ev.id}>
              <circle cx={x} cy={y} r={NODE_R} fill={fill} stroke={stroke} strokeWidth={emphasized ? 2.4 : 1.4} />
              <text
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="12"
                fontWeight={emphasized ? 700 : 500}
                fill={inCycle ? '#ff8f8a' : inTrace ? '#d2a8ff' : '#e6edf3'}
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* 虚拟绝对时间零点（圆心菱形） */}
        {clockIdx !== null && (() => {
          const { x, y } = nodePos(clockIdx, n, clockIdx)
          const inCycle = cycleNodes.has(clockIdx)
          const inTrace = traceNodes?.has(clockIdx) ?? false
          const s = 20
          const points = `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`
          return (
            <g>
              <polygon
                points={points}
                fill={inCycle ? '#3d1f22' : inTrace ? '#2d2440' : '#1f3a57'}
                stroke={inCycle ? '#f85149' : inTrace ? '#bc8cff' : '#4da3ff'}
                strokeWidth={inCycle || inTrace ? 2.6 : 2}
              />
              <text
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="10"
                fontWeight={700}
                fill={inCycle ? '#ff8f8a' : inTrace ? '#d2a8ff' : '#cfe6ff'}
              >
                t=0
              </text>
              <text x={x} y={y + s + 14} textAnchor="middle" fontSize="10.5" fill="#8fb6e8">
                绝对时间零点
              </text>
            </g>
          )
        })()}
      </svg>
      <div className="graph-legend">
        <span>
          <span className="swatch" style={{ background: '#5b7186' }} />
          相对约束边（标注权重 w，含义 t终点 − t起点 ≤ w）
        </span>
        <span>
          <span className="swatch" style={{ background: '#7d92a6', backgroundImage: 'repeating-linear-gradient(90deg,#7d92a6 0 4px,transparent 4px 7px)' }} />
          绝对观测边（虚线，连至时间零点；≤ 上界 / ≥ 下界）
        </span>
        <span>
          <span className="swatch" style={{ background: '#f85149' }} />
          矛盾链
        </span>
        {(traceEdgeIds?.size ?? 0) > 0 && (
          <span>
            <span className="swatch" style={{ background: '#bc8cff' }} />
            边界追溯链
          </span>
        )}
        <span>
          <span className="swatch" style={{ background: '#4da3ff' }} />
          绝对时间零点（t = 0）
        </span>
      </div>
    </div>
  )
}

/** 计算边的二次贝塞尔路径与标签位置；自环画成节点上方的小环 */
function arcPath(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  self: boolean,
  ord: number,
  total: number,
): { path: string; lx: number; ly: number } {
  if (self) {
    const dx = 16 + ord * 6
    const path = `M ${p1.x - 8} ${p1.y - NODE_R + 2}
      C ${p1.x - dx} ${p1.y - NODE_R - 26}, ${p1.x + dx} ${p1.y - NODE_R - 26}, ${p1.x + 8} ${p1.y - NODE_R + 2}`
    return { path, lx: p1.x, ly: p1.y - NODE_R - 22 }
  }

  const mx = (p1.x + p2.x) / 2
  const my = (p1.y + p2.y) / 2
  const vx = p2.x - p1.x
  const vy = p2.y - p1.y
  const len = Math.hypot(vx, vy)
  // 单位法向量
  const nx = -vy / len
  const ny = vx / len
  // 同一条弦上的多条边分摊不同曲率；反向边天然分到另一侧
  const spread = total > 1 ? (ord - (total - 1) / 2) * 26 : 0
  const bend = 34 + spread
  const cxp = mx + nx * bend
  const cyp = my + ny * bend

  // 起止点收到圆周边，避免箭头埋进节点
  const ux = vx / len
  const uy = vy / len
  const sx = p1.x + ux * NODE_R
  const sy = p1.y + uy * NODE_R
  const ex = p2.x - ux * (NODE_R + 6)
  const ey = p2.y - uy * (NODE_R + 6)

  return {
    path: `M ${sx} ${sy} Q ${cxp} ${cyp} ${ex} ${ey}`,
    lx: mx + nx * (bend * 0.62),
    ly: my + ny * (bend * 0.62),
  }
}
