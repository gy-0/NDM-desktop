import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Drives the real NDMHost engine over its socket protocol with an isolated
// support directory and a real browser cookie session. Verifies the native
// Douyin resolver end to end: probe, task creation and file delivery.
//
//   NDM_QA_DOUYIN_GALLERY='https://v.douyin.com/...' npm run qa:douyin-native
//
// Requires the machine to be signed in to Douyin in the chosen browser.

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.NDM_QA_DOUYIN_PORT ?? 51947)
const browser = process.env.NDM_QA_DOUYIN_BROWSER ?? 'chrome:Default'
const videoURL = process.env.NDM_QA_DOUYIN_VIDEO ?? 'https://www.douyin.com/video/7662339530070410737'
const galleryURL = process.env.NDM_QA_DOUYIN_GALLERY ?? ''
const profileURL = process.env.NDM_QA_DOUYIN_PROFILE ?? ''
const musicURL = process.env.NDM_QA_DOUYIN_MUSIC ?? ''
const toolDir = join(root, 'native', 'Vendor', 'Tools')

const release = join(root, 'native', '.build', 'release', 'NDMHost')
const debug = join(root, 'native', '.build', 'debug', 'NDMHost')
const binary = process.env.NDM_QA_DOUYIN_HOST ?? (existsSync(release) ? release : debug)
if (!existsSync(binary)) {
  console.error(`NDMHost 二进制缺失：${binary}（先运行 npm run build:native）`)
  process.exit(1)
}

const supportDir = mkdtempSync(join(tmpdir(), 'ndm-douyin-qa-support-'))
const downloadDir = mkdtempSync(join(tmpdir(), 'ndm-douyin-qa-downloads-'))
const cookieFile = process.env.NDM_QA_DOUYIN_COOKIE_FILE ?? ''
const child = spawn(binary, [], {
  env: {
    ...process.env,
    NDM_HOST_PORT: String(port),
    NDM_SUPPORT_DIR: supportDir,
    ...(cookieFile ? { NDM_DOUYIN_COOKIE_FILE: cookieFile } : {}),
    ...(existsSync(toolDir) ? { NDM_TOOL_DIR: toolDir } : {})
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 8000) stderr = stderr.slice(-8000) })

let buffer = ''
let nextId = 1
const pending = new Map()
let socket = null

function attachSocket(candidate) {
  candidate.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const entry = pending.get(message.id)
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message) }
    }
  })
}

function tryConnect() {
  return new Promise((resolve, reject) => {
    const candidate = createConnection({ host: '127.0.0.1', port })
    candidate.setEncoding('utf8')
    candidate.once('connect', () => resolve(candidate))
    candidate.once('error', reject)
  })
}

async function connect() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      socket = await tryConnect()
      attachSocket(socket)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw new Error('端口连接超时')
}

function request(op, extra = {}, timeoutMs = 240_000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} 超时`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    socket.write(JSON.stringify({ ...extra, id, op }) + '\n')
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`等待超时：${label}`)
}

async function listTasks() {
  const reply = await request('list', {}, 20_000)
  return reply.tasks ?? []
}

function taskFile(task) {
  return task.folderPath ? join(task.folderPath, task.filename) : null
}

function assertFileOnDisk(task) {
  const file = taskFile(task)
  assert.ok(file, `任务 ${task.id} 没有落盘目录`)
  assert.ok(existsSync(file), `文件不存在：${file}`)
  assert.ok(statSync(file).size > 0, `文件为空：${file}`)
  return statSync(file).size
}

const summary = { video: null, gallery: null }

try {
  await connect()
  const ping = await request('ping', {}, 5000)
  assert.equal(ping.ok, true)

  // --- Video: pick the smallest tier, download one file ---
  const probe = await request('probeMedia', { url: videoURL, cookieBrowser: browser })
  if (probe.ok === false) throw new Error(`视频探测失败：${probe.errorKind} ${probe.error}`)
  assert.ok(Array.isArray(probe.formats) && probe.formats.length > 0, '视频没有返回清晰度')
  const override = process.env.NDM_QA_DOUYIN_FORMAT
  const smallest = override
    ? probe.formats.find((format) => format.id === override || format.label === override)
    : probe.formats.reduce((a, b) =>
        (a.approximateBytes ?? Infinity) <= (b.approximateBytes ?? Infinity) ? a : b)
  if (!smallest) throw new Error(`找不到清晰度 ${override}`)
  const added = await request('addMedia', {
    url: videoURL,
    formatID: smallest.id,
    container: 'compatibleMP4',
    collectionScope: 'current',
    cookieBrowser: browser,
    folderPath: downloadDir
  })
  if (added.ok === false) throw new Error(`视频建任务失败：${added.error}`)
  const videoTask = await waitFor(async () => {
    const tasks = await listTasks()
    return tasks.find((task) => task.pageURL?.includes('douyin.com') && task.status !== 'incomplete')
  }, 30_000, '视频任务出现')
  const settled = await waitFor(async () => {
    const tasks = await listTasks()
    const task = tasks.find((candidate) => candidate.id === videoTask.id)
    if (!task) return null
    if (task.status === 'error') throw new Error(`视频下载失败：${task.errorText ?? ''}`)
    return task.status === 'complete' ? task : null
  }, 300_000, '视频下载完成')
  const videoBytes = assertFileOnDisk(settled)
  summary.video = {
    title: probe.title,
    format: smallest.label,
    bytes: videoBytes,
    connections: settled.connections
  }

  // --- Gallery: every image becomes its own task ---
  if (galleryURL) {
    const galleryProbe = await request('probeMedia', { url: galleryURL, cookieBrowser: browser })
    if (galleryProbe.ok === false) throw new Error(`图集探测失败：${galleryProbe.errorKind} ${galleryProbe.error}`)
    assert.deepEqual(galleryProbe.formats.map((format) => format.id), ['douyin-gallery'],
      '图集应只暴露一个“原图”清晰度')
    const maxBefore = Math.max(0, ...(await listTasks()).map((task) => task.id))
    const galleryAdd = await request('addMedia', {
      url: galleryURL,
      formatID: 'douyin-gallery',
      container: 'compatibleMP4',
      collectionScope: 'current',
      cookieBrowser: browser,
      folderPath: downloadDir
    })
    if (galleryAdd.ok === false) throw new Error(`图集建任务失败：${galleryAdd.error}`)
    const created = await waitFor(async () => {
      const tasks = (await listTasks()).filter((task) => task.id > maxBefore)
      return tasks.length >= 2 ? tasks : null
    }, 60_000, '图集任务出现')

    // Wait for every image task to settle; 32 small images should not need
    // the full timeout.
    const settled = await waitFor(async () => {
      const tasks = (await listTasks()).filter((task) => task.id > maxBefore)
      return tasks.every((task) => task.status === 'complete' || task.status === 'error')
        ? tasks
        : null
    }, 420_000, '图集全部结算')
    const failed = settled.filter((task) => task.status === 'error')
    assert.equal(failed.length, 0, `图集任务失败 ${failed.length} 个：${failed[0]?.errorText ?? ''}`)
    const bytes = settled.map((task) => assertFileOnDisk(task))
    summary.gallery = {
      title: galleryProbe.title,
      tasks: created.length,
      completed: settled.length,
      totalBytes: bytes.reduce((sum, value) => sum + value, 0),
      minBytes: Math.min(...bytes),
      maxBytes: Math.max(...bytes)
    }
  }

  // --- Profile batch: one page of works becomes many tasks ---
  if (profileURL) {
    const maxBefore = Math.max(0, ...(await listTasks()).map((task) => task.id))
    const profileProbe = await request('probeMedia', { url: profileURL, cookieBrowser: browser })
    if (profileProbe.ok === false) throw new Error(`主页探测失败：${profileProbe.errorKind} ${profileProbe.error}`)
    assert.deepEqual(profileProbe.formats.map((format) => format.id), ['douyin-batch'],
      '主页应只暴露一个批量清晰度')
    const profileAdd = await request('addMedia', {
      url: profileURL,
      formatID: 'douyin-batch',
      container: 'compatibleMP4',
      collectionScope: 'current',
      cookieBrowser: browser,
      folderPath: downloadDir
    })
    if (profileAdd.ok === false) throw new Error(`主页建任务失败：${profileAdd.error}`)
    const settled = await waitFor(async () => {
      const tasks = (await listTasks()).filter((task) => task.id > maxBefore)
      return tasks.length > 1 && tasks.every((task) => task.status === 'complete' || task.status === 'error')
        ? tasks
        : null
    }, 420_000, '主页任务结算')
    const failed = settled.filter((task) => task.status === 'error')
    assert.equal(failed.length, 0,
      `主页任务失败 ${failed.length} 个：${failed.map((task) => `${task.filename} :: ${task.errorText}`).join(' | ')}`)
    settled.forEach((task) => assertFileOnDisk(task))
    summary.profile = { title: profileProbe.title, tasks: settled.length, connections: settled[0]?.connections ?? 0 }
  }

  // --- Music: a /music link resolves to a single audio task ---
  if (musicURL) {
    const maxBefore = Math.max(0, ...(await listTasks()).map((task) => task.id))
    const musicProbe = await request('probeMedia', { url: musicURL, cookieBrowser: browser })
    if (musicProbe.ok === false) throw new Error(`音乐探测失败：${musicProbe.errorKind} ${musicProbe.error}`)
    assert.deepEqual(musicProbe.formats.map((format) => format.id), ['douyin-audio'],
      '音乐应只暴露原声清晰度')
    const musicAdd = await request('addMedia', {
      url: musicURL,
      formatID: 'douyin-audio',
      container: 'compatibleMP4',
      collectionScope: 'current',
      cookieBrowser: browser,
      folderPath: downloadDir
    })
    if (musicAdd.ok === false) throw new Error(`音乐建任务失败：${musicAdd.error}`)
    const settled = await waitFor(async () => {
      const tasks = (await listTasks()).filter((task) => task.id > maxBefore)
      const task = tasks[0]
      if (!task) return null
      if (task.status === 'error') throw new Error(`音乐下载失败：${task.errorText ?? ''}`)
      return task.status === 'complete' ? task : null
    }, 180_000, '音乐下载完成')
    summary.music = { title: musicProbe.title, bytes: assertFileOnDisk(settled) }
  }

  console.log(JSON.stringify({ passed: true, ...summary }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    passed: false,
    message: error instanceof Error ? error.message : String(error),
    stderr: stderr.split('\n').slice(-6).join('\n')
  }, null, 2))
  process.exitCode = 1
} finally {
  socket?.destroy()
  child.kill()
  await sleep(200)
  if (process.env.NDM_QA_DOUYIN_KEEP) {
    console.error(`kept support=${supportDir} downloads=${downloadDir}`)
  } else {
    rmSync(supportDir, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
}
