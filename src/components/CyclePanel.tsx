import type { Constraint, CycleInfo, TEvent } from '../types'
import { describeConstraint } from '../lib/format'

interface Props {
  cycle: CycleInfo
  events: TEvent[]
  constraints: Constraint[]
}

/** 单条差分边的不等式含义：t_v - t_u <= w */
function edgeInequality(e: CycleInfo['edges'][number], nameOf: (i: number) => string): string {
  const sign = e.w >= 0 ? '+' : '−'
  return `t(${nameOf(e.v)}) − t(${nameOf(e.u)}) ≤ ${sign}${Math.abs(e.w)}`
}

/**
 * 矛盾环复核面板：
 * 以可逐步核对的方式列出环上每条差分不等式，求和后得到 0 ≤ 负数 的矛盾，
 * 并映射回用户录入的原始自然语言约束。
 */
export default function CyclePanel({ cycle, events, constraints }: Props) {
  const nameById = new Map(events.map((e) => [e.id, e.name]))
  const nameOfIdx = (i: number) => events[i]?.name ?? `#${i}`
  const constraintById = new Map(constraints.map((c) => [c.id, c]))

  const involved = new Map<string, Constraint>()
  for (const e of cycle.edges) {
    const c = constraintById.get(e.constraintId)
    if (c && !involved.has(c.id)) involved.set(c.id, c)
  }

  const n = cycle.nodes.length

  return (
    <div className="cycle-box">
      <h4>可复核的矛盾环（{n} 个事件、{cycle.edges.length} 条差分边）</h4>

      <div className="cycle-chain">
        {cycle.nodes.map((nodeIdx, i) => {
          const edge = cycle.edges[i]
          return (
            <span key={i}>
              <span className="node">{nameOfIdx(nodeIdx)}</span>
              <span className="arrow">
                {' '}
                ── <span className="w">{edge.w > 0 ? `+${edge.w}` : edge.w}</span>→{' '}
              </span>
              {i === n - 1 && <span className="node">{nameOfIdx(cycle.nodes[0])}</span>}
            </span>
          )
        })}
      </div>

      <ol className="cycle-constraint-list" style={{ paddingLeft: 18 }}>
        {cycle.edges.map((e, i) => (
          <li key={i} style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
            {edgeInequality(e, nameOfIdx)}
          </li>
        ))}
      </ol>

      <div className="cycle-proof">
        以上不等式全部沿环<strong>左、右分别相加</strong>，各事件时间变量各出现一次正负、恰好抵消，于是得到
        <code> 0 ≤ {cycle.totalWeight}</code>，显然不成立——这就是矛盾的代数证据。
      </div>

      <div className="cycle-proof">
        涉及的原始证词 / 记录（{involved.size} 条，已在上图与约束列表中红色高亮）：
        <ul className="cycle-constraint-list" style={{ paddingLeft: 18, marginTop: 4 }}>
          {[...involved.values()].map((c) => (
            <li key={c.id}>
              {describeConstraint(c, (id) => nameById.get(id) ?? '（已删除事件）')}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
