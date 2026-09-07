// Opt-in public metadata comparison; no media, cookies, user config or raw extractor output.
// NDM_QA_TOOL_DIR defaults to the installed app; NDM_QA_CA_FILE is REQUIRED and must
// point to an existing product-generated macos-system-ca.pem. TLS verification stays on.
import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tools = realpathSync(resolve(process.env.NDM_QA_TOOL_DIR || '/Applications/NDM.app/Contents/Resources/Tools'))
if (!process.env.NDM_QA_CA_FILE) throw new Error('Set NDM_QA_CA_FILE to an existing product-generated CA bundle')
const ca = realpathSync(resolve(process.env.NDM_QA_CA_FILE))
const binary = join(tools, 'yt-dlp'), deno = join(tools, 'deno'), ffmpeg = join(tools, 'ffmpeg')
for (const file of [binary, deno, ffmpeg]) accessSync(file, constants.X_OK)
if (!readFileSync(ca, 'utf8').includes('-----BEGIN CERTIFICATE-----')) throw new Error('CA file is not a PEM certificate bundle')
const home = mkdtempSync(join(tmpdir(), 'ndm-youtube-client-ab-'))
mkdirSync(join(home, '.config'))
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: home, SSL_CERT_FILE: ca }
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const base = ['--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser',
  '--no-cache-dir', '--no-remote-components', '--no-js-runtimes', '--js-runtimes', `deno:${deno}`,
  '--ffmpeg-location', ffmpeg, '--compat-options', 'no-certifi', '--simulate', '--skip-download',
  '--no-check-formats', '--no-playlist', '--dump-single-json', '--no-progress', '--retries', '0',
  '--extractor-retries', '0', '--fragment-retries', '0', '--file-access-retries', '0', '--socket-timeout', '12']
const categories = text => Object.entries({ tls: /certificate|ssl error/i, timeout: /timed out|timeout/i,
  auth: /sign in|login|not a bot/i, poToken: /PO Token/i, jsChallenge: /challenge solving|signature extraction|n challenge/i,
  missingFormat: /formats?.*(missing|unavailable)|no video formats/i, drm: /DRM/i, http403: /403|Forbidden/i
}).filter(([, pattern]) => pattern.test(text)).map(([name]) => name)

function run(args, timeoutMs) {
  return new Promise(resolveResult => {
    let stdout = '', stderr = '', timedOut = false, outputLimited = false
    const started = Date.now()
    const child = spawn(binary, args, { env, cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ } }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 16e6) { outputLimited = true; stop() } })
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 1e6) { outputLimited = true; stop() } })
    child.on('error', () => { clearTimeout(timer); resolveResult({ spawnFailed: true, stdout: '', stderr: '' }) })
    child.on('close', code => { clearTimeout(timer); resolveResult({ code, timedOut, outputLimited, elapsedMs: Date.now() - started, stdout, stderr }) })
  })
}
const version = await run(['--ignore-config', '--version'], 15000)
if (version.code !== 0 || !/^\d{4}\.\d{2}\.\d{2}$/.test(version.stdout.trim())) throw new Error('Tool version preflight failed; no site requests started')
const report = { startedAt: new Date().toISOString(), toolVersion: version.stdout.trim(), toolSHA256: hash(binary),
  denoSHA256: hash(deno), caSHA256: hash(ca),
  policy: { anonymous: true, mediaDownload: false, configFiles: false, retries: 0, timeoutMs: 45000,
    proxyEnvironmentInherited: false, networkRoute: 'system route; not independently traced' }, results: [] }
for (const mode of ['product-explicit', 'tool-default']) {
  const result = await run([...base, ...(mode === 'product-explicit' ? ['--extractor-args', 'youtube:player_client=tv,android,web'] : []),
    '--', 'https://www.youtube.com/watch?v=YE7VzlLtp-4'], 45000)
  const row = { mode, code: result.code ?? null, timedOut: !!result.timedOut, outputLimited: !!result.outputLimited,
    spawnFailed: !!result.spawnFailed, elapsedMs: result.elapsedMs, categories: categories(result.stderr) }
  if (result.code === 0 && !result.outputLimited) {
    try {
      const info = JSON.parse(result.stdout)
      const formats = Array.isArray(info.formats) ? info.formats : []
      const video = formats.filter(item => item.vcodec && item.vcodec !== 'none' && item.vcodec !== 'images')
      Object.assign(row, { formatCount: formats.length, videoCount: video.length,
        audioOnlyCount: formats.filter(item => item.vcodec === 'none' && item.acodec && item.acodec !== 'none').length,
        maxHeight: Math.max(0, ...video.map(item => Number(item.height) || 0)),
        heights: [...new Set(video.map(item => Number(item.height)).filter(value => value > 0))].sort((a, b) => a - b) })
    } catch { row.invalidMetadata = true }
  }
  report.results.push(row)
  console.log(JSON.stringify(row))
}
report.toolUnchanged = report.toolSHA256 === hash(binary)
const reportPath = join(home, 'report.json')
writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ reportPath, toolUnchanged: report.toolUnchanged }))
