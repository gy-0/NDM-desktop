// Real isolated Host: sparse legacy checkpoints exercise offsets above 4 GiB without downloading a huge file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, stat, rm, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection, createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const binary = process.argv[2];
if (!binary)
    throw Error('Pass an isolated Host');
const root = await mkdtemp(join(tmpdir(), 'ndm-large-offset-')), support = join(root, 'support'), home = join(root, 'home'), downloads = join(root, 'downloads');
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
const totalBytes = 4 * 1024 ** 3 + 16 * 1024 ** 2, prefixBytes = 4 * 1024 ** 3 + 65536, ranges = [];
let restarted = false;
const server = createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : totalBytes - 1;
  ranges.push({ method: req.method, start, restarted });
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', ETag: '\"legacy-progress\"',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${totalBytes}` } : {})
  });
  if (req.method === 'HEAD') { res.end(); return; }
  let position = start, timer;
  res.on('close', () => clearTimeout(timer));
  function send() {
    if (res.destroyed) return;
    const next = Math.min(end + 1, position + 65536);
    if (position - start >= 262144) return; // Stay partial: no multi-GiB final assembly.
    const chunk = Buffer.alloc(next - position, position >= prefixBytes ? 0xa5 : 0);
    res.write(chunk); position = next;
    if (position > end) res.end();
    else timer = setTimeout(send, 15);
  }
  send();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let host, exited, sequence = 0;
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
    plan.writeBigInt64LE(BigInt(totalBytes - 1), 16);
    await writeFile(join(work, 'segments.bin'), plan);
    const part = join(work, 'seg.x0');
    await writeFile(part, Buffer.alloc(0));
    const task = async () => (await rpc('list')).tasks.find(t => t.id === id);
    // Obtain a real validated request/representation identity before seeding sparse bytes.
    assert.equal((await rpc('resume', { taskID: id })).ok, true);
    await until('initial representation', async () => { const value = await task(); assert.notEqual(value.status, 'error', value.errorText); return value.completedBytes >= 65536; });
    assert.equal((await rpc('pause', { taskID: id })).ok, true);
    host.kill('SIGTERM'); await exited;
    const sparse = await open(part, 'r+');
    try { await sparse.truncate(prefixBytes); } finally { await sparse.close(); }
    assert.ok((await stat(part)).blocks * 512 < 1024 * 1024, 'Fixture must remain sparse');
    launch();
    await until('seed restart ready', async () => (await rpc('ping').catch(() => null))?.ok);
    assert.equal((await task()).completedBytes, prefixBytes);
    const generations = [];
    let retained = prefixBytes;
    for (let generation = 0; generation < 2; generation++) {
        const prior = retained;
        const requestIndex = ranges.length;
        assert.equal((await rpc('resume', { taskID: id })).ok, true);
        await until('large offset progress', async () => {
            const value = await task();
            assert.notEqual(value.status, 'error', value.errorText);
            return value.completedBytes >= prior + 131072;
        });
        assert.equal((await rpc('pause', { taskID: id })).ok, true);
        const metadata = await stat(part);
        retained = metadata.size;
        assert.ok(retained > prior && retained < totalBytes);
        assert.ok(metadata.blocks * 512 < 4 * 1024 * 1024, 'Avoid allocating a real multi-GiB fixture');
        assert.ok(ranges.slice(requestIndex).some(r => r.method === 'GET' && r.start === prior), 'Range must preserve the full 64-bit offset');
        const handle = await open(part, 'r');
        const tail = Buffer.alloc(retained - prefixBytes);
        try { const result = await handle.read(tail, 0, tail.length, prefixBytes); assert.equal(result.bytesRead, tail.length); }
        finally { await handle.close(); }
        assert.deepEqual(tail, Buffer.alloc(tail.length, 0xa5));
        generations.push({ prior, retained, allocatedBytes: metadata.blocks * 512, tailSHA256: createHash('sha256').update(tail).digest('hex') });
        host.kill('SIGTERM'); await exited; restarted = true; launch();
        await until('restart ready', async () => (await rpc('ping').catch(() => null))?.ok);
        const requestsBefore = ranges.length, restored = await task();
        assert.equal(restored.completedBytes, retained);
        assert.equal(restored.fileSize, totalBytes);
        assert.equal(restored.progressFraction, retained / totalBytes);
        assert.equal(restored.status, 'paused');
        assert.equal(ranges.length, requestsBefore, 'Listing must not resume or probe the remote file');
        assert.equal((await rpc('list')).tasks.length, 1);
    }
    console.log(JSON.stringify({ passed: true, scope: 'Sparse checkpoint and 64-bit partial resume only; not a complete multi-GiB download', totalBytes, prefixBytes, generations }));
}
finally {
    if (host && host.exitCode === null && host.signalCode === null) {
        host.kill('SIGTERM');
        await exited;
    }
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ cleanup: true }));
}
