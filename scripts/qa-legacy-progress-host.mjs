// Real isolated Host: legacy checkpoints remain visible after restart, then resume exactly.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection, createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const binary = process.argv[2];
if (!binary)
    throw Error('Pass an isolated Host');
const root = await mkdtemp(join(tmpdir(), 'ndm-legacy-progress-')), support = join(root, 'support'), home = join(root, 'home'), downloads = join(root, 'downloads');
for (const p of [support, home, downloads])
    await mkdir(p);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(label, predicate, timeout = 30000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const result = await predicate();
    if (result) return result;
    await delay(50);
  }
  throw Error(label);
}
async function freePort() {
  const server = tcpServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
const port = await freePort(), bridge = await freePort();
const payload = randomBytes(8 * 1024 * 1024), ranges = [];
let restarted = false;
const server = createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : payload.length - 1;
  ranges.push({ method: req.method, start, restarted });
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', ETag: '\"legacy-progress\"',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
  });
  if (req.method === 'HEAD') { res.end(); return; }
  let position = start, timer;
  res.on('close', () => clearTimeout(timer));
  function send() {
    if (res.destroyed) return;
    const next = Math.min(end + 1, position + 65536);
    res.write(payload.subarray(position, next)); position = next;
    if (position > end) res.end();
    else timer = setTimeout(send, 15);
  }
  send();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let host, exited, rendererFixture, sequence = 0;
function launch() {
  host = spawn(binary, [], { stdio: 'ignore', env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root,
    NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge),
    NDM_DISABLE_LEGACY_BRIDGE: '1'
  } });
  exited = once(host, 'exit');
}
function rpc(op, extra = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, socket = createConnection({ host: '127.0.0.1', port });
    let buffer = '', settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true; socket.destroy();
      error ? reject(error) : resolve(value);
    }
    socket.setTimeout(5000, () => finish(Error(op + ' timeout')));
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(Error(op + ' closed')));
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, ...extra }) + '\n'));
    socket.on('data', data => {
      buffer += data;
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { const reply = JSON.parse(line); if (reply.id === id) finish(null, reply); }
        catch { finish(Error('Malformed RPC')); }
      }
    });
  });
}
try {
    launch();
    await until('ready', async () => (await rpc('ping').catch(() => null))?.ok);
    const created = await rpc('add', { url: `http://127.0.0.1:${server.address().port}/legacy.bin`, filename: 'legacy.bin', folderPath: downloads, connections: 1, autoStart: false });
    assert.equal(created.ok, true);
    const id = created.task.id, work = join(support, String(id));
    await mkdir(work, { recursive: true });
    const plan = Buffer.alloc(24);
    plan.writeInt16LE(0, 0);
    plan.writeInt16LE(0, 2);
    plan.writeInt32LE(-1, 4);
    plan.writeBigInt64LE(0n, 8);
    plan.writeBigInt64LE(BigInt(payload.length - 1), 16);
    await writeFile(join(work, 'segments.bin'), plan);
    await writeFile(join(work, 'seg.x0'), Buffer.alloc(0));
    assert.equal((await rpc('resume', { taskID: id })).ok, true);
    const task = async () => (await rpc('list')).tasks.find(t => t.id === id);
    await until('progress before pause', async () => (await task()).completedBytes >= 262144);
    assert.equal((await rpc('pause', { taskID: id })).ok, true);
    const bytes = (await stat(join(work, 'seg.x0'))).size;
    assert.ok(bytes > 0 && bytes < payload.length);
    const before = await readFile(join(work, 'seg.x0'));
    host.kill('SIGTERM');
    await exited;
    restarted = true;
    launch();
    await until('restart ready', async () => (await rpc('ping').catch(() => null))?.ok);
    const requestsBefore = ranges.length, restored = await task();
    assert.deepEqual(await readFile(join(work, 'seg.x0')), before);
    assert.equal(ranges.length, requestsBefore);
    console.log(JSON.stringify({ durableBytes: bytes, restoredBytes: restored.completedBytes, status: restored.status, fileSize: restored.fileSize, linkType: restored.linkType }));
    if (process.argv.includes('--browser-ui')) {
        const { startRendererHostFixture } = await import('./qa-renderer-host-fixture.mjs');
        rendererFixture = await startRendererHostFixture(rpc);
        console.log(JSON.stringify({ uiReady: true, url: rendererFixture.url }));
    } else {
        assert.equal((await rpc('resume', { taskID: id })).ok, true);
    }
    const complete = await until('completion', async () => { const t = await task(); assert.notEqual(t.status, 'error', t.errorText); return t.status === 'complete' && t; }, rendererFixture ? 180000 : 30000);
    const actual = await readFile(join(downloads, complete.filename));
    assert.deepEqual(actual, payload);
    assert.ok(ranges.some(r => r.restarted && r.method === 'GET' && r.start === bytes));
    console.log(JSON.stringify({ sameTask: complete.id === id, actualBytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex'), resumedFrom: bytes }));
    assert.equal(restored.completedBytes, bytes, 'Restarted legacy task must show its retained bytes');
    assert.equal(restored.fileSize, payload.length);
    assert.equal(restored.progressFraction, bytes / payload.length);
    if (rendererFixture) await delay(15000);
}
finally {
    if (rendererFixture) await rendererFixture.close();
    if (host && host.exitCode === null && host.signalCode === null) {
        host.kill('SIGTERM');
        await exited;
    }
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ cleanup: true }));
}
