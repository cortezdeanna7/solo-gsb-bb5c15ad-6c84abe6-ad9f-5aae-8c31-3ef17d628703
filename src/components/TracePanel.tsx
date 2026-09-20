import type { BoundTrace, Constraint, TEvent } from '../types'
import { describeConstraint, formatAbsolute, formatFullDateTime } from '../lib/format'

interface Props {
  trace: BoundTrace
  events: TEvent[]
  /** 与图/分析一致的（可能叠加了修复预览的）有效约束 */
  constraints: Constraint[]
  anchorId: string | null
  anchorTime: string
  onClose: () => void
}

/** 带符号的分钟数：+5 / −2 / 0 */
function signed(n: number): string {
  if (n > 0) return `+${n}`
  if (n < 0) return `−${Math.abs(n)}`
  return '0'
}

/**
 * 边界依据追溯面板：逐步列出从锚点推导某事件最早/最晚边界所采用的
 * 原始约束、上/下界侧与累计偏移；锚点自身给出零步证明。
 */
export default function TracePanel({ trace, events, constraints, anchorId, anchorTime, onClose }: Props) {
  const nameOfIdx = (i: number) => events[i]?.name ?? `#${i}`
  const anchorName = anchorId != null ? (events.find((e) => e.id === anchorId)?.name ?? '锚点') : '锚点'
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  const orderOf = new Map(constraints.map((c, i) => [c.id, i + 1]))
  const nameById = new Map(events.map((e) => [e.id, e.name]))

  const targetName = nameOfIdx(trace.eventIdx)
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

      {trace.steps.length === 0 ? (
        <div className="trace-zero">
          「{targetName}」<strong>就是锚点事件</strong>：其{kindLabel}边界由锚点定义直接给出
          （相对自身偏移 0 分钟，即 {formatFullDateTime(anchorTime)}），
          <strong>不经过任何约束推导 —— 零步证明</strong>。
        </div>
      ) : (
        <>
          <div className="trace-intro">
            {trace.kind === 'latest' ? (
              <>
                最晚边界 = 正向差分图上锚点到该事件的最短路。沿链依次有
                t(下一事件) − t(上一事件) ≤ w，求和即得 t({targetName}) − t({anchorName}) ≤ {signed(trace.offset)}。
              </>
            ) : (
              <>
                最早边界在<strong>反向差分图</strong>上推导：沿链依次有 t(上一事件) − t(下一事件) ≤ w，
                求和得 t({anchorName}) − t({targetName}) ≤ {signed(totalWeight)}，即
                t({targetName}) − t({anchorName}) ≥ {signed(trace.offset)}。
                下列步骤已按从锚点出发的推导顺序<strong>还原为原始约束</strong>（标注「反向」的为反向使用该约束的不等式）。
              </>
            )}
            链上约束与节点已在差分图和约束列表中同步高亮。
          </div>

          <ol className="trace-steps">
            {trace.steps.map((st, i) => {
              const c = constraintById.get(st.edge.constraintId)
              const backward = st.edge.u !== st.from
              return (
                <li key={i} className="trace-step">
                  <div className="trace-step-head">
                    <span className="trace-step-no">第 {i + 1} 步</span>
                    <span className="trace-step-path">
                      「{nameOfIdx(st.from)}」→「{nameOfIdx(st.to)}」
                    </span>
                    {backward && <span className="trace-step-dir">反向</span>}
                  </div>
                  <div className="trace-step-body">
                    {c ? (
                      <>
                        原始约束 <code className="order-no">#{orderOf.get(c.id)}</code>{' '}
                        {describeConstraint(c, (id) => nameById.get(id) ?? '（已删除事件）')}
                      </>
                    ) : (
                      '（约束已删除）'
                    )}
                    <br />
                    采用{st.edge.bound === 'upper' ? '上界' : '下界'}侧不等式：
                    <code>
                      t({nameOfIdx(st.edge.v)}) − t({nameOfIdx(st.edge.u)}) ≤ {signed(st.edge.w)}
                    </code>
                    <br />
                    累计偏移：t({nameOfIdx(st.to)}) − t({anchorName}){' '}
                    {trace.kind === 'latest' ? '≤' : '≥'} <code>{signed(st.cumulative)}</code> 分钟
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
                ，即 t({targetName}) − t({anchorName}) ≤ {signed(trace.offset)} 分钟。
                故「{targetName}」最晚为锚点时间 {signed(trace.offset)} 分钟 =
                <strong> {formatAbsolute(anchorTime, trace.offset)}</strong>。
              </>
            ) : (
              <>
                各步权重求和：
                <code>
                  {trace.steps.map((st) => signed(st.edge.w)).join(' + ')} = {signed(totalWeight)}
                </code>
                ，即 t({anchorName}) − t({targetName}) ≤ {signed(totalWeight)}，亦即 t({targetName}) − t({anchorName}) ≥{' '}
                {signed(trace.offset)} 分钟。 故「{targetName}」最早为锚点时间 {signed(trace.offset)} 分钟 =
                <strong> {formatAbsolute(anchorTime, trace.offset)}</strong>。
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
