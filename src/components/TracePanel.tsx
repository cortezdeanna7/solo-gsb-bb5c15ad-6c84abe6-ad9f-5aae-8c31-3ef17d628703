import type { BoundTrace, Constraint, Observation, TEvent } from '../types'
import { describeConstraint, describeObservation, formatEpochMin } from '../lib/format'

interface Props {
  trace: BoundTrace
  events: TEvent[]
  /** 与图/分析一致的（可能叠加了修复预览的）有效约束与观测 */
  constraints: Constraint[]
  observations: Observation[]
  onClose: () => void
}

const CLOCK_NAME = '绝对时间零点'

/** 带符号的分钟数：+5 / −2 / 0 */
function signed(n: number): string {
  if (n > 0) return `+${n}`
  if (n < 0) return `−${Math.abs(n)}`
  return '0'
}

/**
 * 边界依据追溯面板：逐步列出从绝对时间零点推导某事件最早/最晚边界所采用的
 * 原始观测 / 相对约束、上/下界侧与累计绝对时刻。
 * 链上可同时出现观测边与约束边；反向使用的边标注「反向」。
 */
export default function TracePanel({ trace, events, constraints, observations, onClose }: Props) {
  const nameOfNode = (i: number) =>
    i === trace.clockIdx ? CLOCK_NAME : events[i]?.name ?? `#${i}`
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  const observationById = new Map(observations.map((o) => [o.id, o]))
  const orderConstraint = new Map(constraints.map((c, i) => [c.id, i + 1]))
  const orderObservation = new Map(observations.map((o, i) => [o.id, i + 1]))
  const eventNameById = new Map(events.map((e) => [e.id, e.name]))

  const targetName = nameOfNode(trace.eventIdx)
  const kindLabel = trace.kind === 'earliest' ? '最早' : '最晚'
  const totalWeight = trace.steps.reduce((s, st) => s + st.edge.w, 0)

  return (
    <div className="trace-box">
      <div className="trace-head">
        <h4>
          边界依据追溯：「{targetName}」的{kindLabel}时间
          <span className="trace-kind">{kindLabel === '最早' ? '下界' : '上界'}推导链</span>
        </h4>
        <button className="small" onClick={onClose} title="关闭追溯">
          关闭
        </button>
      </div>

      <div className="trace-intro">
        {trace.kind === 'latest' ? (
          <>
            最晚边界 = 正向差分图上时间零点到该事件的最短路。沿链依次有
            t(下一节点) − t(上一节点) ≤ w，求和即得 t({targetName}) ≤ {trace.offset}
            （纪元分钟数）= <strong>{formatEpochMin(trace.offset)}</strong>。
          </>
        ) : (
          <>
            最早边界在<strong>反向差分图</strong>上推导：沿链依次有 t(上一节点) − t(下一节点) ≤ w，
            求和得 −t({targetName}) ≤ {signed(totalWeight)}，即
            t({targetName}) ≥ {trace.offset} = <strong>{formatEpochMin(trace.offset)}</strong>。
            下列步骤已按从时间零点出发的推导顺序<strong>还原为原始边</strong>（标注「反向」的为反向使用该边的不等式）。
          </>
        )}
        链上观测、约束与节点已在差分图和对应列表中同步高亮。
      </div>

      <ol className="trace-steps">
        {trace.steps.map((st, i) => {
          const c = st.edge.origin === 'constraint' ? constraintById.get(st.edge.sourceId) : null
          const o = st.edge.origin === 'observation' ? observationById.get(st.edge.sourceId) : null
          const backward = st.edge.u !== st.from
          return (
            <li key={i} className="trace-step">
              <div className="trace-step-head">
                <span className="trace-step-no">第 {i + 1} 步</span>
                <span className="trace-step-path">
                  「{nameOfNode(st.from)}」→「{nameOfNode(st.to)}」
                </span>
                {backward && <span className="trace-step-dir">反向</span>}
                {st.edge.origin === 'observation' && <span className="trace-step-dir obs">观测</span>}
              </div>
              <div className="trace-step-body">
                {c && (
                  <>
                    原始约束 <code className="order-no">#{orderConstraint.get(c.id)}</code>{' '}
                    {describeConstraint(c, (id) => eventNameById.get(id) ?? '（已删除事件）')}
                  </>
                )}
                {o && (
                  <>
                    绝对观测 <code className="order-no">观#{orderObservation.get(o.id)}</code>{' '}
                    {describeObservation(o, eventNameById.get(o.eventId) ?? '（已删除事件）')}
                  </>
                )}
                {!c && !o && '（来源已删除）'}
                <br />
                采用{st.edge.bound === 'upper' ? '上界' : '下界'}侧不等式：
                <code>
                  t({nameOfNode(st.edge.v)}) − t({nameOfNode(st.edge.u)}) ≤ {signed(st.edge.w)}
                </code>
                {st.edge.origin === 'observation' && (
                  <>
                    {' '}（即 {st.edge.bound === 'upper' ? `不晚于 ${formatEpochMin(st.edge.w)}` : `不早于 ${formatEpochMin(-st.edge.w)}`}）
                  </>
                )}
                <br />
                累计：t({nameOfNode(st.to)}) {trace.kind === 'latest' ? '≤' : '≥'}{' '}
                <code>{st.cumulative}</code> = <strong>{formatEpochMin(st.cumulative)}</strong>
              </div>
            </li>
          )
        })}
      </ol>

      <div className="trace-proof">
        {trace.kind === 'latest' ? (
          <>
            各步权重求和：
            <code>
              {trace.steps.map((st) => signed(st.edge.w)).join(' + ')} = {signed(totalWeight)}
            </code>
            ，即 t({targetName}) ≤ {trace.offset}。故「{targetName}」最晚为
            <strong> {formatEpochMin(trace.offset)}</strong>。
          </>
        ) : (
          <>
            各步权重求和：
            <code>
              {trace.steps.map((st) => signed(st.edge.w)).join(' + ')} = {signed(totalWeight)}
            </code>
            ，即 −t({targetName}) ≤ {signed(totalWeight)}，亦即 t({targetName}) ≥ {trace.offset}。
            故「{targetName}」最早为
            <strong> {formatEpochMin(trace.offset)}</strong>。
          </>
        )}
      </div>
    </div>
  )
}
