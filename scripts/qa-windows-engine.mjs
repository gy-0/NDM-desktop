import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const aria2Path = '/opt/homebrew/bin/aria2c'
const ytDlpPath = '/Users/gaoyuan/NDM/Vendor/Tools/yt-dlp'
const ffmpegPath = '/Users/gaoyuan/NDM/Vendor/Tools/ffmpeg'
for (const [tool, path] of Object.entries({ aria2c: aria2Path, 'yt-dlp': ytDlpPath, ffmpeg: ffmpegPath })) {
  if (!existsSync(path)) throw new Error(`本机缺少 ${tool}，无法执行 Windows 引擎协议 QA`)
}

const temporary = await mkdtemp(join(tmpdir(), 'ndm-windows-engine-qa-'))
const bundle = join(temporary, 'windows-engine.mjs')
await build({
  entryPoints: ['src/main/windows/windowsEngine.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle
})
const { WindowsDownloadEngine } = await import(pathToFileURL(bundle).href)

const payload = Buffer.allocUnsafe(8 * 1024 * 1024)
for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
const expectedHash = createHash('sha256').update(payload).digest('hex')

const mediaDirectory = join(temporary, 'media')
await mkdir(mediaDirectory, { recursive: true })
const fixture = spawnSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=duration=36:size=640x360:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=36',
  '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'mpeg4', '-b:v', '2500k',
  '-c:a', 'aac', '-b:a', '128k',
  '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1',
  join(mediaDirectory, 'manifest.mpd')
], { encoding: 'utf8' })
assert.equal(fixture.status, 0, fixture.stderr || '无法生成 DASH QA 素材')
const mediaFiles = new Map(await Promise.all((await readdir(mediaDirectory)).map(async (name) => (
  [name, await readFile(join(mediaDirectory, name))]
))))

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const mediaName = pathname.startsWith('/media/') ? pathname.slice('/media/'.length) : ''
  const body = pathname === '/payload.bin' ? payload : mediaFiles.get(mediaName)
  if (!body) {
    response.statusCode = 404
    response.end()
    return
  }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = range ? Number(range[1]) : 0
  const end = range && range[2] ? Math.min(body.length - 1, Number(range[2])) : body.length - 1
  response.statusCode = range ? 206 : 200
  response.setHeader('accept-ranges', 'bytes')
  response.setHeader('content-type', mediaName.endsWith('.mpd') ? 'application/dash+xml' : 'application/octet-stream')
  response.setHeader('content-length', end - start + 1)
  if (range) response.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  let offset = start
  const timer = setInterval(() => {
    if (offset > end || response.destroyed) {
      clearInterval(timer)
      if (!response.destroyed) response.end()
      return
    }
    const next = Math.min(end + 1, offset + (mediaName ? 8 : 64) * 1024)
    response.write(body.subarray(offset, next))
    offset = next
  }, mediaName ? 60 : 40)
  response.on('close', () => clearInterval(timer))
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert.ok(address && typeof address === 'object')

let latestStatus = 'connecting'
const snapshots = []
let resolveLive
const live = new Promise((resolveValue) => { resolveLive = resolveValue })
const engine = new WindowsDownloadEngine({
  stateDirectory: join(temporary, 'state'),
  defaultDownloadDirectory: join(temporary, 'downloads'),
  aria2Path,
  ytDlpPath,
  ffmpegPath,
  rpcPort: 52000 + Math.floor(Math.random() * 1000)
}, {
  onStatus(status) {
    latestStatus = status
    if (status === 'live') resolveLive()
  },
  onEvent(message) {
    if (message.op === 'snapshot') snapshots.push(message.tasks)
  }
})

const waitForTask = async (id, predicate, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const reply = await engine.request('list')
    const task = reply.tasks?.find((candidate) => candidate.id === id)
    if (task && predicate(task)) return task
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('等待 Windows 引擎状态超时')
}

try {
  void engine.start()
  await Promise.race([
    live,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`引擎未启动：${latestStatus}`)), 8_000))
  ])

  const added = await engine.request('add', {
    url: `http://127.0.0.1:${address.port}/payload.bin`,
    filename: 'Windows 引擎 QA.bin',
    connections: 2
  })
  assert.equal(added.ok, true)
  const ariaTaskID = added.task.id
  await waitForTask(ariaTaskID, (task) => task.status === 'downloading' && task.completedBytes > 0)
  await engine.request('pause', { taskID: ariaTaskID })
  const paused = await waitForTask(ariaTaskID, (task) => task.status === 'paused')
  assert.ok(paused.completedBytes > 0 && paused.completedBytes < payload.length)
  await engine.request('resume', { taskID: ariaTaskID })
  const completed = await waitForTask(ariaTaskID, (task) => task.status === 'complete', 30_000)
  assert.equal(completed.completedBytes, payload.length)
  assert.equal(completed.fileSize, payload.length)
  const actual = await readFile(join(temporary, 'downloads', 'Windows 引擎 QA.bin'))
  assert.equal(createHash('sha256').update(actual).digest('hex'), expectedHash)

  const manifestURL = `http://127.0.0.1:${address.port}/media/manifest.mpd`
  const probed = await engine.request('probeMedia', { url: manifestURL })
  assert.equal(probed.ok, true)
  const mergedFormat = probed.formats.find((format) => format.id.includes('+'))
  assert.ok(mergedFormat, 'DASH 探测未返回可合流的音视频格式')
  const mediaAdded = await engine.request('addMedia', {
    url: manifestURL,
    formatID: mergedFormat.id,
    container: 'compatibleMP4',
    filename: 'Windows 双轨媒体 QA.mp4',
    folderPath: join(temporary, 'downloads')
  })
  assert.equal(mediaAdded.ok, true)
  assert.equal(mediaAdded.task.status, 'downloading')
  const mediaTaskID = mediaAdded.task.id
  const mediaActive = await waitForTask(mediaTaskID, (task) => (
    task.status === 'downloading' && task.completedBytes > 0 && task.segments.length > 0
  ), 30_000)
  await engine.request('pause', { taskID: mediaTaskID })
  const mediaPaused = await waitForTask(mediaTaskID, (task) => task.status === 'paused')
  assert.ok(mediaPaused.completedBytes > 0)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))
  const stillPaused = await waitForTask(mediaTaskID, (task) => task.status === 'paused')
  assert.equal(stillPaused.completedBytes, mediaPaused.completedBytes)
  await engine.request('resume', { taskID: mediaTaskID })
  const mediaCompleted = await waitForTask(mediaTaskID, (task) => task.status === 'complete', 90_000)
  const mediaOutputPath = join(temporary, 'downloads', 'Windows 双轨媒体 QA.mp4')
  const mediaOutput = await readFile(mediaOutputPath)
  assert.equal(mediaCompleted.completedBytes, mediaOutput.length)
  const decode = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', mediaOutputPath,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'
  ], { encoding: 'utf8' })
  assert.equal(decode.status, 0, decode.stderr || '合流产物缺少可解码的音视频轨道')

  await engine.request('restart', { taskID: mediaTaskID })
  await waitForTask(mediaTaskID, (task) => task.status === 'downloading' && task.completedBytes > 0, 30_000)
  assert.equal(existsSync(mediaOutputPath), false, '重新下载应先移除旧的完整产物')
  await engine.request('pause', { taskID: mediaTaskID })
  await waitForTask(mediaTaskID, (task) => task.status === 'paused')
  const partialArtifacts = (await readdir(join(temporary, 'downloads')))
    .filter((name) => name.startsWith('Windows 双轨媒体 QA'))
  assert.ok(partialArtifacts.length > 0, '暂停应保留 yt-dlp 临时文件以便续传')
  await engine.request('remove', { taskID: mediaTaskID, deleteFile: true })
  const removedArtifacts = (await readdir(join(temporary, 'downloads')))
    .filter((name) => name.startsWith('Windows 双轨媒体 QA'))
  assert.deepEqual(removedArtifacts, [], '删除任务应一并移除 yt-dlp 临时文件')

  assert.ok(snapshots.length > 2)
  console.log(JSON.stringify({
    engine: 'aria2 RPC',
    pauseResume: 'passed',
    bytes: payload.length,
    sha256: expectedHash,
    media: {
      engine: 'yt-dlp + ffmpeg',
      selector: mergedFormat.id,
      pauseResume: 'passed',
      bytesBeforePause: mediaActive.completedBytes,
      outputBytes: mediaOutput.length,
      sha256: createHash('sha256').update(mediaOutput).digest('hex'),
      audioVideoDecode: 'passed'
    },
    snapshots: snapshots.length
  }, null, 2))
} finally {
  engine.stop()
  await new Promise((resolveClose) => server.close(resolveClose))
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  await rm(temporary, { recursive: true, force: true })
}
