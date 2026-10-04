// Summarize an isolated qa-electron-native-startup report and its Chromium trace.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const path = process.argv[2]
assert.ok(path, 'Pass the QA report.json path')
const report = JSON.parse(await readFile(path, 'utf8'))
assert.ok(report.completionTrace, 'Report must contain completionTrace')
const { traceEvents } = JSON.parse(await readFile(report.completionTrace, 'utf8'))
const complete = traceEvents.find(event => event.name === 'ndm-qa-complete')
const fire = traceEvents.find(event => event.name === 'ndm-qa-confetti-fire' && event.ts >= complete?.ts)
assert.ok(complete && fire, 'Completion and fire markers must be present')
const start = complete.ts - 100000, end = complete.ts + 2500000
const spans = traceEvents.filter(event => event.ph === 'X' && event.pid === complete.pid && event.tid === complete.tid
  && Number.isFinite(event.dur) && event.ts < end && event.ts + event.dur >= start)
const summarize = event => ({ name: event.name, afterCompletionMS: (event.ts - complete.ts) / 1000, durationMS: event.dur / 1000 })
const tasks = spans.filter(event => event.name === 'RunTask')
const summary = {
  root: report.root, app: report.app, hostSHA256: report.hostSHA256,
  trace: report.completionTrace, passed: report.passed,
  scope: 'Renderer main-thread complete spans overlapping completion [-100,+2500] ms; tracing overhead applies; no pixel-presentation or compositor-stall conclusion',
  completionFrames: report.completionFrames,
  traceEventToFireMS: (fire.ts - complete.ts) / 1000,
  mainThreadTaskCount: tasks.length,
  longestMainThreadTasks: tasks.sort((a,b) => b.dur-a.dur).slice(0,10).map(summarize),
  longestMainThreadSpans: spans.filter(event => !['RunTask','ThreadControllerImpl::RunTask'].includes(event.name))
    .sort((a,b) => b.dur-a.dur).slice(0,10).map(summarize)
}
console.log(JSON.stringify(summary, null, 2))
