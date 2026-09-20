/**
 * 冒烟测试：在 Node 中以 SSR 方式渲染 App 与时间窗/追溯面板，验证渲染链路不抛异常、
 * 关键文案（观测面板、推导步骤、反向标记、不可追溯原因、分层排程各层结果）存在。
 * 运行：npm run smoke（见 package.json scripts）
 */
import { renderToString } from 'react-dom/server'
import { createElement as h } from 'react'
import App from '../src/App'
import WindowsTable from '../src/components/WindowsTable'
import { analyze, traceBound } from '../src/lib/graph'
import { buildConsistentSample } from '../src/lib/samples'

let failed = 0
/** React SSR 会在插值文本之间插入 <!-- -->，先去除再做片段匹配 */
function check(rawHtml: string, fragment: string, label: string) {
  const html = rawHtml.replace(/<!-- -->/g, '')
  if (!html.includes(fragment)) {
    failed++
    console.error('SMOKE FAIL:', label, '缺少片段:', fragment)
  }
}

// 1) 整个 App 初始渲染
const appHtml = renderToString(h(App))
check(appHtml, '各事件的绝对时间窗', 'App')
check(appHtml, '差分约束图', 'App')
check(appHtml, '点击最早/最晚时间可追溯边界推导链', 'App')
check(appHtml, '绝对时间观测', 'App')
check(appHtml, '绝对时间零点', 'App')
check(appHtml, '精确时刻 · 零宽区间', 'App')

// 1b) 分层最小偏差排程（默认示例：恢复=高优先级 期望 +25 → 高层 D=5；复盘=低优先级 → 低层 D=0）
check(appHtml, '分层最小偏差排程', '分层最小偏差排程')
check(appHtml, '期望时刻', '分层最小偏差排程')
check(appHtml, '高优先级', '分层最小偏差排程')
check(appHtml, '中优先级', '分层最小偏差排程')
check(appHtml, '低优先级', '分层最小偏差排程')
check(appHtml, 'D = 5', '分层最小偏差排程')
check(appHtml, 'D = 0', '分层最小偏差排程')
check(appHtml, '无参与事件', '分层最小偏差排程')
check(appHtml, '最大偏差', '分层最小偏差排程')
check(appHtml, '达到 ±D', '分层最小偏差排程')
check(appHtml, '层级', '分层最小偏差排程')
check(appHtml, '已定时', '分层最小偏差排程')
check(appHtml, '未定时', '分层最小偏差排程')

// 2) 主时间窗表 + 三种追溯形态
const s = buildConsistentSample()
const r = analyze(s.events, s.constraints, s.observations)
const byName = new Map(s.events.map((e, i) => [e.name, i]))
const alertIdx = byName.get('值班告警触发')!
const recovered = byName.get('服务恢复')!

const renderTable = (eventIdx: number, kind: 'earliest' | 'latest') =>
  renderToString(
    h(WindowsTable, {
      events: s.events,
      windows: r.windows,
      cycleEventIds: new Set<string>(),
      trace: traceBound(s.events, s.constraints, s.observations, eventIdx, kind),
      constraints: s.constraints,
      observations: s.observations,
      onTrace: () => {},
      onCloseTrace: () => {},
    }),
  )

// 精确观测事件：单步观测证明
const alertHtml = renderTable(alertIdx, 'latest')
check(alertHtml, '边界依据追溯', '观测事件追溯')
check(alertHtml, '第 1 步', '观测事件追溯')
check(alertHtml, '观测', '观测事件追溯')
check(alertHtml, '绝对观测', '观测事件追溯')

// 最晚边界：观测 + 单步上界链
const latestHtml = renderTable(recovered, 'latest')
check(latestHtml, '边界依据追溯', '最晚追溯')
check(latestHtml, '第 2 步', '最晚追溯')
check(latestHtml, '采用上界侧不等式', '最晚追溯')
check(latestHtml, '累计', '最晚追溯')

// 最早边界：反向图 4 步链（观测 + 3 约束），步骤带「反向」标记
const earliestHtml = renderTable(recovered, 'earliest')
check(earliestHtml, '反向差分图', '最早追溯')
check(earliestHtml, '第 4 步', '最早追溯')
check(earliestHtml, '反向', '最早追溯')
check(earliestHtml, '采用下界侧不等式', '最早追溯')

// 无法定时事件：单元格不可点击且说明原因
check(earliestHtml, '未被任何绝对时间观测连通，无法定时，最早边界不存在、不可追溯', '不可追溯原因')
check(earliestHtml, '未被任何绝对时间观测连通，无法定时，最晚边界不存在、不可追溯', '不可追溯原因')

if (failed > 0) process.exit(1)
console.log('smoke ok')
