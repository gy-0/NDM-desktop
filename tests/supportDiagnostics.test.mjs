import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSupportReport } from '../src/shared/supportDiagnostics.ts'
import { SupportDiagnosticsService } from '../src/main/supportDiagnostics.ts'

const runtime = { version: '2026.9.19', build: '2026091901', platform: 'darwin', arch: 'arm64', release: '25.0.0' }
const secret = 'PRIVATE-cookie-file-path-url'
const taskReply = { ok: true, tasks: [{ status: 'complete', filename: secret, url: secret, headers: [secret], folderPath: secret }, { status: 'error', errorText: secret }] }
const bridgeReply = { bridge: { available: true, connectedClients: 2, expectedRelayVersion: '1.4.16', relayClients: [{ role: 'worker', version: '1.4.16', secret }, { role: 'worker', version: secret }] }, secret }
const request = async op => op === 'list' ? taskReply : bridgeReply

test('support report allowlist excludes private data even in version and error fields', () => {
  const report = buildSupportReport(runtime, taskReply, bridgeReply)
  assert.match(report, /构建：2026091901/)
  assert.match(report, /已完成：1/); assert.match(report, /失败：1/)
  assert.match(report, /已连接扩展版本：1.4.16、未确认/)
  assert.doesNotMatch(report, new RegExp(secret))
  assert.doesNotMatch(buildSupportReport(Object.fromEntries(Object.keys(runtime).map(key => [key, secret])), { error: secret }, { error: secret }), new RegExp(secret))
})

test('unavailable and malformed states remain unknown rather than healthy or zero', () => {
  const report = buildSupportReport(runtime, { ok: false, tasks: [] }, { bridge: { available: false, connectedClients: -1 } })
  assert.match(report, /下载引擎：暂不可用/); assert.match(report, /浏览器桥接：未就绪/)
  assert.match(report, /浏览器连接数：未确认/); assert.doesNotMatch(report, /任务总数：/)
})

test('export requires a current preview and writes precisely its text, ignoring supplied text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-support-test-'))
  try {
    const path = join(root, 'report.txt')
    let picks = 0
    const service = new SupportDiagnosticsService({ runtime, request, chooseExportPath: async () => { picks++; return path } })
    assert.equal((await service.request('supportDiagnosticsExport', { token: 'forged' })).ok, false)
    assert.equal(picks, 0)
    const { preview } = await service.request('supportDiagnosticsPreview')
    assert.equal((await service.request('supportDiagnosticsExport', { token: preview.token, text: secret })).saved, true)
    assert.equal(await readFile(path, 'utf8'), preview.text)
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cancel and save failure preserve preview; new or expired previews reject stale export', async () => {
  let now = 0, mode = 'cancel', writes = 0
  const service = new SupportDiagnosticsService({ runtime, request, now: () => now,
    chooseExportPath: async () => mode === 'cancel' ? null : '/fixture/report.txt',
    writeText: async () => { if (mode === 'fail') throw new Error(secret); writes++ }
  })
  const { preview } = await service.request('supportDiagnosticsPreview')
  assert.equal((await service.request('supportDiagnosticsExport', { token: preview.token })).canceled, true)
  mode = 'fail'
  const failure = await service.request('supportDiagnosticsExport', { token: preview.token })
  assert.equal(failure.ok, false); assert.doesNotMatch(failure.error, new RegExp(secret))
  mode = 'save'
  assert.equal((await service.request('supportDiagnosticsExport', { token: preview.token })).saved, true)
  await service.request('supportDiagnosticsPreview')
  assert.equal((await service.request('supportDiagnosticsExport', { token: preview.token })).ok, false)
  const fresh = (await service.request('supportDiagnosticsPreview')).preview
  now = 600001
  assert.equal((await service.request('supportDiagnosticsExport', { token: fresh.token })).ok, false)
  assert.equal(writes, 1)
})

test('hung engine yields bounded diagnostic and simultaneous preview requests are rejected', async () => {
  const service = new SupportDiagnosticsService({ runtime, request: () => new Promise(() => {}), timeoutMs: 10, chooseExportPath: async () => null })
  const first = service.request('supportDiagnosticsPreview')
  assert.equal((await service.request('supportDiagnosticsPreview')).ok, false)
  const result = await first
  assert.equal(result.ok, true); assert.match(result.preview.text, /下载引擎：暂不可用/)
})
