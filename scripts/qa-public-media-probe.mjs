// Opt-in network probe; intentionally excluded from deterministic CI tests.
// No media downloads, browser cookies, external plugins, or raw extractor logs.
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(root, 'native/Vendor/Tools/yt-dlp');
const deno = resolve(root, 'native/Vendor/Tools/deno');
const targets = [
  { site: 'YouTube', url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4', source: 'https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py' },
  { site: 'Vimeo', url: 'https://vimeo.com/76979871', source: 'https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/vimeo.py' },
  { site: 'Bilibili', url: 'https://www.bilibili.com/video/BV13x41117TL', source: 'https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py' },
];

function run(file, args, timeoutMs) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn(file, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, outputLimited = false;
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = (kind, chunk) => {
      if (kind === 'out') stdout += chunk; else stderr += chunk;
      if (stdout.length > 16 * 1024 * 1024 || stderr.length > 1024 * 1024) { outputLimited = true; stop(); }
    };
    child.stdout.setEncoding('utf8').on('data', chunk => collect('out', chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => collect('err', chunk));
    child.on('error', () => { clearTimeout(timer); resolveResult({ code: null, spawnFailed: true, elapsedMs: Date.now() - started, stdout: '', stderr: '' }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, outputLimited, elapsedMs: Date.now() - started, stdout, stderr }); });
  });
}

// Emit categorical diagnostics only. stderr may contain signed URLs or tokens.
function diagnostics(text) {
  return [
    ['http-403', /HTTP Error 403|403 Forbidden/i],
    ['http-412', /HTTP Error 412/i],
    ['http-429', /HTTP Error 429|Too Many Requests/i],
    ['authentication-or-bot-check', /sign in|login required|log in|not a bot|cookies.*needed/i],
    ['drm', /DRM protected/i],
    ['unavailable', /not available|unavailable|has been removed|private video/i],
    ['network-timeout', /timed out|timeout/i],
    ['network-resolution-or-connect', /resolve|connection refused|network is unreachable|connection reset/i],
    ['tls-certificate', /certificate verify failed|SSL.*error/i],
    ['missing-js-runtime', /No supported JavaScript runtime|JavaScript runtime.*not found/i],
    ['js-challenge', /challenge solving|n challenge|signature extraction/i],
    ['po-token', /PO Token|PO token/i],
    ['missing-impersonation', /impersonat.*not available|no impersonate target/i],
    ['missing-formats', /formats?.*(?:missing|unavailable)|no video formats/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    network: { route: 'inherited process/system network; not independently traced', proxyEnvironmentPresent: Object.keys(process.env).some(key => /^(https?|all)_proxy$/i.test(key) && process.env[key]) },
    policy: { mediaDownload: false, browserCookies: false, configFiles: false, retries: 0, perSiteTimeoutMs: 45000, checkMediaFormats: false },
    results: [],
  };
  try { await access(binary); } catch { report.toolStatus = 'missing'; console.log(JSON.stringify(report, null, 2)); return; }
  report.binarySHA256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const version = await run(binary, ['--ignore-config', '--version'], 10000);
  report.version = /^\d{4}\.\d{2}\.\d{2}/.test(version.stdout.trim()) ? version.stdout.trim().slice(0, 80) : 'unknown';
  if (version.code !== 0) { report.toolStatus = 'not-runnable'; console.log(JSON.stringify(report, null, 2)); return; }
  let hasDeno = false;
  try { await access(deno); hasDeno = true; } catch { /* explicitly report unavailable */ }
  report.bundledDeno = hasDeno;
  const args = ['--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--no-remote-components', '--no-js-runtimes',
    ...(hasDeno ? ['--js-runtimes', `deno:${deno}`] : []),
    '--simulate', '--skip-download', '--no-check-formats', '--no-playlist', '--dump-single-json', '--no-progress',
    '--retries', '0', '--extractor-retries', '0', '--fragment-retries', '0', '--file-access-retries', '0', '--socket-timeout', '12'];
  // Keep warnings in memory for categorical diagnostics; never print raw text.
  for (const target of targets) {
    const result = await run(binary, [...args, '--', target.url], 45000);
    const row = { ...target, code: result.code, elapsedMs: result.elapsedMs, timedOut: !!result.timedOut, status: 'failed', diagnostics: diagnostics(result.stderr) };
    if (result.spawnFailed) row.status = 'spawn-failed';
    else if (result.outputLimited) row.status = 'output-limit';
    else if (result.timedOut) row.status = 'timeout';
    else if (result.code === 0) {
      try {
        const info = JSON.parse(result.stdout);
        const formats = Array.isArray(info.formats) ? info.formats : [];
        row.status = formats.length ? 'metadata-and-formats' : 'metadata-only';
        row.durationSeconds = typeof info.duration === 'number' ? info.duration : null;
        row.formatCount = formats.length;
        row.videoFormatCount = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.ext !== 'mhtml').length;
        row.audioOnlyFormatCount = formats.filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none').length;
        row.maxVideoHeight = Math.max(0, ...formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.ext !== 'mhtml').map(f => Number(f.height) || 0));
        row.liveStatus = ['not_live', 'is_live', 'is_upcoming', 'was_live', 'post_live'].includes(info.live_status) ? info.live_status : null;
      } catch { row.status = 'invalid-json'; }
    }
    report.results.push(row);
  }
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}
await main();
