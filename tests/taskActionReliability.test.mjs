import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const hero = fs.readFileSync('src/renderer/src/components/Hero.tsx', 'utf8')
const inspector = fs.readFileSync('src/renderer/src/components/Inspector.tsx', 'utf8')
const row = fs.readFileSync('src/renderer/src/components/TaskRow.tsx', 'utf8')
const virtualList = fs.readFileSync('src/renderer/src/components/VirtualTaskList.tsx', 'utf8')

test('single-task lifecycle entry points share one acknowledged action runner', () => {
  assert.match(app, /const runTaskAction = useCallback\(async \(task: Task, kind: 'toggle' \| 'restart'\)/)
  assert.match(app, /try \{[\s\S]*?await restartTask\(task\.id\)[\s\S]*?await toggle\(task\.id\)[\s\S]*?catch/)
  assert.match(app, /setTaskActionError\(`未能\$\{verb\}/)
  assert.match(app, /onToggle=\{\(task\) => void runTaskAction\(task, 'toggle'\)\}/)
  assert.match(app, /onTaskRestart=\{\(task\) => void runTaskAction\(task, 'restart'\)\}/)
  assert.match(app, /onRestart=\{\(t\) => void runTaskAction\(t, 'restart'\)\}/)
  assert.match(app, /void runTaskAction\(selectedTask, 'toggle'\)/)
})

test('task action failures remain visible and associated across task surfaces', () => {
  assert.match(app, /id="task-action-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(app, /aria-label="关闭任务操作提示"/)
  assert.match(hero, /disabled=\{actionBusy\}[\s\S]*?aria-describedby=\{actionErrorId\}/)
  assert.match(row, /disabled=\{actionBusy\}[\s\S]*?describedBy=\{actionErrorId\}/)
  assert.match(inspector, /disabled=\{taskActionBusy\}[\s\S]*?describedBy=\{taskActionErrorId\}/)
  assert.match(virtualList, /actionBusy=\{actionBusyTaskID === item\.task\.id\}/)
  assert.doesNotMatch(hero, /\btoggle\(/)
  assert.doesNotMatch(row, /\b(?:toggle|restartTask)\(/)
  assert.doesNotMatch(inspector, /\b(?:toggle|restartTask)\(/)
})
