import type { Constraint, CycleInfo, Observation, TEvent } from '../types'
import { describeConstraint, describeObservation, formatEpochMin } from '../lib/format'

interface Props {
  cycle: CycleInfo
  events: TEvent[]
  constraints: Constraint[]
  observations: Observation[]
  /** 虚拟时间零点节点下标 */
  clockIdx: number | null
}

const CLOCK_NAME = '绝对时间零点'

/** 单条差分边的不等式含义：t_v - t_u <= w（相对约束边：分钟偏移） */
function edgeInequality(e: CycleInfo['edges'][number], nameOfNode: (i: number) => string): string {
  const sign = e.w >= 0 ? '+' : '−'
  return `t(${nameOfNode(e.v)}) − t(${nameOfNode(e.u)}) ≤ ${sign}${Math.abs(e.w)}`
}

/**
 * 观测边的人话描述：上界侧为“事件不晚于某时刻”，下界侧为“事件不早于某时刻”。
 * 权重为纪元分钟数，直接展示换算后的绝对时间。
 */
function observationMeaning(
  e: CycleInfo['edges'][number],
  events: TEvent[],
): string {
  const node = e.bound === 'upper' ? e.v : e.u
  const name = events[node]?.name ?? `#${node}`
  if (e.bound === 'upper') {
    return `「${name}」不晚于 ${formatEpochMin(e.w)}　（t(${name}) − t(${CLOCK_NAME}) ≤ ${e.w}）`
  }
  return `「${name}」不早于 ${formatEpochMin(-e.w)}　（t(${CLOCK_NAME}) − t(${name}) ≤ ${e.w}）`
}

/**
 * 矛盾链复核面板：
 * 以可逐步核对的方式列出链上每条差分不等式（观测边换算为绝对时刻），
 * 求和后得到 0 ≤ 负数 的矛盾，并分别映射回用户录入的原始相对约束与绝对观测。
 * 链上可能同时包含观测与原约束——冲突在统一差分图中一次性检出，不做逐锚点判断。
 */
export default function CyclePanel({ cycle, events, constraints, observations, clockIdx }: Props) {
  const nameById = new Map(events.map((e) => [e.id, e.name]))
  const nameOfNode = (i: number) =>
    i === clockIdx ? CLOCK_NAME : events[i]?.name ?? `#${i}`
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  const observationById = new Map(observations.map((o) => [o.id, o]))

  const involvedConstraints = new Map<string, Constraint>()
  const involvedObservations = new Map<string, Observation>()
  for (const e of cycle.edges) {
    if (e.origin === 'constraint') {
      const c = constraintById.get(e.sourceId)
      if (c && !involvedConstraints.has(c.id)) involvedConstraints.set(c.id, c)
    } else {
      const o = observationById.get(e.sourceId)
      if (o && !involvedObservations.has(o.id)) involvedObservations.set(o.id, o)
    }
  }

  const n = cycle.nodes.length

  return (
    <div className="cycle-box">
      <h4>
        可复核的矛盾链（{n} 个节点、{cycle.edges.length} 条差分边
        {cycle.involvesObservation ? '，含绝对时间观测' : ''}）
      </h4>

      <div className="cycle-chain">
        {cycle.nodes.map((nodeIdx, i) => {
          const edge = cycle.edges[i]
          return (
            <span key={i}>
              <span className="node">{nameOfNode(nodeIdx)}</span>
              <span className="arrow">
                {' '}
                ── <span className="w">{edge.w > 0 ? `+${edge.w}` : edge.w}</span>→{' '}
              </span>
              {i === n - 1 && <span className="node">{nameOfNode(cycle.nodes[0])}</span>}
            </span>
          )
        })}
      </div>

      <ol className="cycle-constraint-list" style={{ paddingLeft: 18 }}>
        {cycle.edges.map((e, i) => (
          <li key={i} style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
            {e.origin === 'observation' ? observationMeaning(e, events) : edgeInequality(e, nameOfNode)}
          </li>
        ))}
      </ol>

      <div className="cycle-proof">
        以上不等式全部沿链<strong>左、右分别相加</strong>，各时间变量各出现一次正负、恰好抵消
        {cycle.involvesObservation && <>（含绝对时间零点 t({CLOCK_NAME}) = 0）</>}，于是得到
        <code> 0 ≤ {cycle.totalWeight}</code>（分钟），显然不成立——这就是矛盾的代数证据。
      </div>

      {involvedObservations.size > 0 && (
        <div className="cycle-proof">
          涉及的绝对时间观测（{involvedObservations.size} 条，已在图与观测列表中红色高亮）：
          <ul className="cycle-constraint-list" style={{ paddingLeft: 18, marginTop: 4 }}>
            {[...involvedObservations.values()].map((o) => (
              <li key={o.id}>
                {describeObservation(o, nameById.get(o.eventId) ?? '（已删除事件）')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {involvedConstraints.size > 0 && (
        <div className="cycle-proof">
          涉及的原始证词 / 相对约束（{involvedConstraints.size} 条，已在上图与约束列表中红色高亮）：
          <ul className="cycle-constraint-list" style={{ paddingLeft: 18, marginTop: 4 }}>
            {[...involvedConstraints.values()].map((c) => (
              <li key={c.id}>
                {describeConstraint(c, (id) => nameById.get(id) ?? '（已删除事件）')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {cycle.involvesObservation && (
        <div className="cycle-proof">
          注：观测与相对约束在<strong>同一张差分图</strong>中求解，本矛盾链同时引用了
          {involvedObservations.size > 0 && '观测'}
          {involvedObservations.size > 0 && involvedConstraints.size > 0 && '与'}
          {involvedConstraints.size > 0 && '相对约束'}
          ；停用链上任一条目即可打断该链（见下方最小修复建议）。
        </div>
      )}
    </div>
  )
}
