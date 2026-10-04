#!/usr/bin/env python3
"""Isolated CrossOver smoke test, not a Windows acceptance test.

With --transfer, download only a generated loopback fixture. Otherwise no task
is submitted. Only a private copy's bridge port is changed.
The bottle and logs remain in the printed temporary directory for inspection.
"""
import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import shutil
from pathlib import Path
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from identity_guard import IdentityGuard

EXPECTED = '60b06db7dfeb6fffb1be82f8ad059d61bdb1b1a3889439b56eaac162e64c0f37'
BIN = Path('/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin')
POST_BODY = b'name=fixture&unicode=%E4%B8%AD&repeat=1&repeat=2'
POST_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8'


def fixture(report, slow=False, post=False):
    body = os.urandom((32 if slow else 8) * 1024 * 1024)
    report['fixtureBytes'] = len(body)
    report['fixtureSHA256'] = hashlib.sha256(body).hexdigest()
    report['requests'] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_HEAD(self):
            self.serve(False)

        def do_GET(self):
            self.serve(True)

        def do_POST(self):
            self.serve(True)

        def serve(self, send_body):
            body, etag = self.server.fixture_state
            request_body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            report['requests'].append({'method': self.command, 'path': self.path, 'range': self.headers.get('Range'),
                                       'ifMatch': self.headers.get('If-Match'),
                                       'ifRange': self.headers.get('If-Range'), 'responseETag': etag,
                                       'bodyBytes': len(request_body),
                                       'bodySHA256': hashlib.sha256(request_body).hexdigest(),
                                       'contentType': self.headers.get('Content-Type')})
            if post and (self.command != 'POST' or request_body != POST_BODY
                         or self.headers.get('Content-Type') != POST_CONTENT_TYPE):
                self.send_error(400, 'Expected POST and exact fixture body')
                return
            if self.headers.get('If-Match') not in (None, '*', etag):
                self.send_error(412)
                return
            start, end = 0, len(body) - 1
            requested = self.headers.get('Range')
            if self.headers.get('If-Range') not in (None, etag):
                requested = None
            if requested:
                left, right = requested.removeprefix('bytes=').split('-', 1)
                start, end = int(left), int(right) if right else end
            if not (0 <= start <= end < len(body)):
                self.send_error(416)
                return
            self.send_response(206 if requested else 200)
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('ETag', etag)
            if requested:
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(body)}')
            self.end_headers()
            if send_body:
                try:
                    chunk = 16384 if slow else 65536
                    for offset in range(start, end + 1, chunk):
                        self.wfile.write(body[offset:min(offset + chunk, end + 1)])
                        time.sleep(0.03 if slow else 0.01)
                except (BrokenPipeError, ConnectionResetError):
                    pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.original_body = body
    server.fixture_state = (body, '"ndm-windows-fixture-v1"')
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def submit(conn, url, post=False):
    payload = f'1:{"POST" if post else "GET"}\r\n2:{url}\r\n6:normal\r\n'.encode()
    if post:
        payload += f'Content-Type: {POST_CONTENT_TYPE}\r\n'.encode()
        payload += b'__0NeatPostData9__:' + POST_BODY
    mask = os.urandom(4)
    header = bytes([0x81, 0x80 | len(payload)]) if len(payload) < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', len(payload))
    conn.sendall(header + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))


def handshake(conn, port):
    key = base64.b64encode(os.urandom(16)).decode()
    conn.sendall(f'GET /download HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: neatextension.v1\r\n\r\n'.encode())
    response = b''
    while b'\r\n\r\n' not in response and len(response) < 8192:
        block = conn.recv(2048)
        if not block:
            break
        response += block
    accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
    if not response.startswith(b'HTTP/1.1 101') or accept not in response:
        raise RuntimeError('Invalid WebSocket handshake')
    return response.decode(errors='replace')


def task_status(bottle, url):
    database = bottle / 'drive_c/users/crossover/AppData/Roaming/NeatDM/NeatDB.db'
    if not database.is_file():
        return None
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    try:
        rows = connection.execute('SELECT id,status,method FROM downloads WHERE url=?', (url,)).fetchall()
        if len(rows) != 1:
            raise RuntimeError(f'Expected one durable task, got {len(rows)}')
        return {'id': rows[0][0], 'status': rows[0][1], 'method': rows[0][2]}
    finally:
        connection.close()


def remap_port(data, port):
    """Version-pinned PE RVA translation; reject unexpected instruction bytes."""
    if hashlib.sha256(data).hexdigest() != EXPECTED:
        raise ValueError('Unverified original EXE')
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    count = struct.unpack_from('<H', data, pe + 6)[0]
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    table = pe + 24 + optional_size
    rva = 0x4e269c - 0x400000
    for index in range(count):
        entry = table + index * 40
        size, address, raw_size, raw = struct.unpack_from('<IIII', data, entry + 8)
        if address <= rva and rva + 5 <= address + min(size, raw_size):
            offset = raw + rva - address
            if data[offset:offset + 5] != bytes.fromhex('b817270000'):
                raise ValueError('Bridge port instruction mismatch')
            patched = bytearray(data)
            struct.pack_into('<I', patched, offset + 1, port)
            return bytes(patched), offset
    raise ValueError('Bridge port instruction not found')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('exe', type=Path)
    parser.add_argument('--transfer', action='store_true')
    parser.add_argument('--inspect-ui', action='store_true', help='Read-only Win32 window inventory during the private transfer')
    parser.add_argument('--pause-resume', action='store_true', help='Pause the exact fixture task, check stable segments, then resume')
    parser.add_argument('--identity-change', action='store_true', help='Replace paused resource with same-length different bytes and ETag')
    parser.add_argument('--identity-guard', action='store_true', help='Route through the research response-ETag guard')
    parser.add_argument('--post-audit', action='store_true', help='Use a repeatable local POST export fixture and verify request bodies')
    parser.add_argument('--restart-engine', action='store_true', help='Stop the private bottle after settled pause and restore its saved task')
    parser.add_argument('--multi-task', action='store_true', help='Keep a completed decoy task while restoring the paused task by ID')
    parser.add_argument('--cc', default=shutil.which('i686-w64-mingw32-gcc'), help='Explicit MinGW compiler path for the Win32 helper')
    args = parser.parse_args()
    if (args.inspect_ui or args.pause_resume) and not args.transfer:
        parser.error('--inspect-ui/--pause-resume requires --transfer')
    if args.identity_change and not args.pause_resume:
        parser.error('--identity-change requires --pause-resume')
    if args.identity_guard and not args.transfer:
        parser.error('--identity-guard requires --transfer')
    if args.post_audit and (not args.transfer or args.identity_guard or args.identity_change):
        parser.error('--post-audit requires --transfer and direct unchanged-resource transport')
    if args.restart_engine and not args.pause_resume:
        parser.error('--restart-engine requires --pause-resume')
    if args.multi_task and (not args.restart_engine or args.post_audit or args.identity_change or args.identity_guard):
        parser.error('--multi-task requires direct unchanged GET with --restart-engine')
    if (args.inspect_ui or args.pause_resume) and (not args.cc or not os.access(args.cc, os.X_OK)):
        parser.error('Win32 helper compiler unavailable; provide --cc /path/to/i686-w64-mingw32-gcc')
    original = args.exe.read_bytes()
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1', 0))
        port = reserved.getsockname()[1]
        patched, offset = remap_port(original, port)
    root = Path(tempfile.mkdtemp(prefix='ndm-windows-engine-smoke-'))
    bottle = root / 'bottle'
    print(root, flush=True)
    home = Path.home()
    policy = root / 'isolation.sb'
    policy.write_text(f'''(version 1)
(allow default)
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny network-inbound (local ip "*:*"))
(allow network-inbound (local ip "localhost:*"))
(deny file-write* (subpath "{home}"))
(deny file-read* (subpath "{home}/Library/Application Support/com.NeatDownloadManager"))
(deny file-read* (subpath "{home}/Library/Application Support/NDM"))
''')
    env = dict(os.environ, CX_BOTTLE_PATH=str(root), CX_BOTTLE=str(bottle))
    sandbox = ['sandbox-exec', '-f', str(policy)]
    wine = sandbox + [str(BIN / 'wine'), '--bottle', str(bottle), '--no-gui']
    report = {'sourceSHA256': EXPECTED, 'patchedPort': port,
              'patchFileOffset': offset, 'patchedSHA256': hashlib.sha256(patched).hexdigest(),
              'runtime': 'CrossOver; not native Windows', 'handshakePassed': False}
    proc = None
    server = None
    guard = None
    try:
        with (root / 'create.log').open('w') as log:
            subprocess.run(sandbox + [str(BIN / 'cxbottle'), '--bottle', str(bottle),
                           '--scope', 'private', '--create', '--template', 'win10_64',
                           '--description', 'NDM engine isolated smoke'], env=env,
                           stdout=log, stderr=subprocess.STDOUT, timeout=90, check=True)
        # Replace only symlinks in this newly created bottle, never their targets.
        # Keep Wine's z: mapping; the inherited sandbox protects the real home.
        for path in bottle.rglob('*'):
            if path.is_symlink() and str(path.resolve()).startswith(str(home) + '/'):
                path.unlink()
                path.mkdir()
            elif path.is_symlink() and path.resolve() == home:
                path.unlink()
                path.mkdir()
        target = bottle / 'drive_c/NDMResearch'
        target.mkdir()
        (target / 'NeatDM.exe').write_bytes(patched)
        if args.inspect_ui or args.pause_resume:
            subprocess.run([args.cc, str(Path(__file__).with_name('inspect.c')),
                            '-o', str(target / 'inspect.exe'), '-municode', '-luser32'], check=True)
        with (root / 'engine.log').open('w') as log:
            proc = subprocess.Popen(wine + ['--wait', r'C:\NDMResearch\NeatDM.exe'],
                                    env=env, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(f'Original process exited: {proc.returncode}')
                try:
                    conn = socket.create_connection(('127.0.0.1', port), timeout=1)
                except OSError:
                    time.sleep(0.2)
                    continue
                with conn:
                    report['handshake'] = handshake(conn, port)
                    report['handshakePassed'] = True
                    if args.transfer:
                        server = fixture(report, slow=args.inspect_ui or args.pause_resume, post=args.post_audit)
                        target_port = server.server_port
                        if args.identity_guard:
                            guard = IdentityGuard(server.server_port, root / 'identity-pins.json')
                            threading.Thread(target=guard.serve_forever, daemon=True).start()
                            target_port = guard.server_port
                        url = f'http://127.0.0.1:{target_port}/reuse-smoke.bin'
                        submit(conn, url, post=args.post_audit)
                        if args.inspect_ui:
                            time.sleep(0.15)
                            inventory = subprocess.run(wine + [r'C:\NDMResearch\inspect.exe'], env=env,
                                                       capture_output=True, timeout=15)
                            (root / 'windows.txt').write_bytes(inventory.stdout)
                            report['inventoryExit'] = inventory.returncode
                        if args.pause_resume:
                            time.sleep(1)
                            def control(action):
                                result = subprocess.run(wine + [r'C:\NDMResearch\inspect.exe', action, url],
                                                        env=env, capture_output=True, timeout=15)
                                report[action + 'ControlExit'] = result.returncode
                                if result.returncode:
                                    raise RuntimeError(f'{action} control failed: {result.returncode}')
                            control('pause')
                            storage = bottle / 'drive_c/users/crossover/AppData/Roaming/NeatDM'
                            def segments():
                                return {str(p.relative_to(storage)): hashlib.sha256(p.read_bytes()).hexdigest()
                                        for p in storage.rglob('*') if p.is_file() and p.name.lower().startswith('seg')}
                            settle_deadline = time.monotonic() + 8
                            before = segments()
                            while time.monotonic() < settle_deadline:
                                time.sleep(1)
                                after = segments()
                                if before and before == after:
                                    report['pauseStableSegments'] = after
                                    break
                                before = after
                            if not report.get('pauseStableSegments'):
                                report['storageFiles'] = [str(p.relative_to(storage)) for p in storage.rglob('*') if p.is_file()]
                                raise RuntimeError('Paused segment hashes did not settle')
                            report['pausedTask'] = task_status(bottle, url)
                            if args.multi_task:
                                decoy_url = f'http://127.0.0.1:{target_port}/decoy.bin'
                                # The original browser extension submits on its persistent connection.
                                submit(conn, decoy_url)
                                report['decoyConnection'] = 'existing'
                                decoy_deadline = time.monotonic() + 25
                                while time.monotonic() < decoy_deadline:
                                    try:
                                        decoy = task_status(bottle, decoy_url)
                                    except RuntimeError:
                                        decoy = None
                                    if decoy and decoy['status'] == 'Complete':
                                        report['decoyTask'] = decoy
                                        break
                                    time.sleep(0.2)
                                if 'decoyTask' not in report or decoy['id'] == report['pausedTask']['id']:
                                    inventory = subprocess.run(wine + [r'C:\NDMResearch\inspect.exe'], env=env, capture_output=True, timeout=15)
                                    (root / 'failed-intake-windows.txt').write_bytes(inventory.stdout)
                                    raise RuntimeError('Independent decoy task did not complete')
                                decoy_path = bottle / 'drive_c/users/crossover/Downloads/decoy.bin'
                                report['decoySHA256'] = hashlib.sha256(decoy_path.read_bytes()).hexdigest()
                                if report['decoySHA256'] != report['fixtureSHA256']:
                                    raise RuntimeError('Decoy file mismatch')
                            report['requestsBeforeResume'] = len(report['requests'])
                            if args.identity_change:
                                changed = bytes(byte ^ 255 for byte in server.original_body)
                                server.fixture_state = (changed, '"ndm-windows-fixture-v2"')
                                report['replacementSHA256'] = hashlib.sha256(changed).hexdigest()
                            if args.restart_engine:
                                old_pid = proc.pid
                                subprocess.run(wine + ['--ux-app', 'wineserver', '-k'], env=env, capture_output=True, timeout=20, check=True)
                                subprocess.run(wine + ['--ux-app', 'wineserver', '-w'], env=env, capture_output=True, timeout=20, check=True)
                                proc.wait(timeout=15)
                                if segments() != report['pauseStableSegments']:
                                    raise RuntimeError('Engine exit changed paused segments')
                                saved = task_status(bottle, url)
                                if not saved or saved['id'] != report['pausedTask']['id'] or not saved['status'].startswith('Paused'):
                                    raise RuntimeError('Exited engine did not retain the paused task')
                                report['persistedTaskAfterExit'] = saved
                                proc = subprocess.Popen(wine + ['--wait', r'C:\NDMResearch\NeatDM.exe'],
                                                        env=env, stdout=log, stderr=subprocess.STDOUT)
                                report['restartLauncherPIDs'] = [old_pid, proc.pid]
                                restore_deadline = time.monotonic() + 25
                                while time.monotonic() < restore_deadline:
                                    if segments() != report['pauseStableSegments']:
                                        raise RuntimeError('Engine restart changed paused segments before restore')
                                    if args.multi_task and not report.get('unknownTaskRejected'):
                                        rejected = subprocess.run(wine + [r'C:\NDMResearch\inspect.exe', 'restore-id', '2147483647', 'reuse-smoke.bin'],
                                                                  env=env, capture_output=True, timeout=15)
                                        if rejected.returncode in (2, 10):
                                            time.sleep(0.3)
                                            continue
                                        if rejected.returncode != 13:
                                            raise RuntimeError(f'Unknown task ID was not rejected: {rejected.returncode}')
                                        time.sleep(0.5)
                                        if len(report['requests']) != report['requestsBeforeResume'] or segments() != report['pauseStableSegments']:
                                            raise RuntimeError('Unknown task request changed transfer state')
                                        report['unknownTaskRejected'] = True
                                    restored = subprocess.run(wine + [r'C:\NDMResearch\inspect.exe', 'restore-id', str(saved['id']), 'reuse-smoke.bin'],
                                                              env=env, capture_output=True, timeout=15)
                                    (root / 'restore.log').write_bytes(restored.stdout + restored.stderr)
                                    report['restoreControlExit'] = restored.returncode
                                    if restored.returncode == 0:
                                        match = re.search(rb'restore task=(\d+) row=(\d+) total=(\d+)', restored.stdout)
                                        if not match or int(match[1]) != saved['id']:
                                            raise RuntimeError('Restore helper did not confirm target ID')
                                        report['restoredRow'] = {'taskID': int(match[1]), 'index': int(match[2]), 'total': int(match[3])}
                                        if args.multi_task and int(match[3]) != 2:
                                            raise RuntimeError('Multi-task fixture did not retain two rows')
                                        report['segmentsPreservedAcrossRestart'] = True
                                        break
                                    if restored.returncode not in (2, 10):
                                        raise RuntimeError(f'Restore control failed: {restored.returncode}')
                                    time.sleep(0.3)
                                if report.get('restoreControlExit') != 0:
                                    raise TimeoutError('Saved task did not become available for restore')
                            else:
                                control('resume')
                        report['transferPassed'] = False
                        transfer_deadline = time.monotonic() + 25
                        while time.monotonic() < transfer_deadline:
                            if args.identity_change and guard is not None:
                                record = task_status(bottle, url)
                                if (record and record['status'].startswith('Error')
                                        and any(event.get('blocked') for event in guard.events)):
                                    time.sleep(1)
                                    if segments() != report['pauseStableSegments']:
                                        raise RuntimeError('Identity rejection changed saved segments')
                                    if list((bottle / 'drive_c').rglob('reuse-smoke.bin')):
                                        raise RuntimeError('Identity rejection left a final output file')
                                    report.update(identityConflictBlocked=True, segmentsUnchanged=True, finalTask=record)
                                    break
                            for output in (bottle / 'drive_c').rglob('reuse-smoke.bin'):
                                if output.is_file() and output.stat().st_size == report['fixtureBytes']:
                                    actual = hashlib.sha256(output.read_bytes()).hexdigest()
                                    expected_hash = report.get('replacementSHA256', report['fixtureSHA256'])
                                    if actual == expected_hash:
                                        record = task_status(bottle, url)
                                        if record and record['status'] == 'Complete':
                                            if args.pause_resume and record['id'] != report['pausedTask']['id']:
                                                raise RuntimeError('Completion belongs to a different task')
                                            report.update(transferPassed=True, completedTask=record, output=str(output.relative_to(bottle)), outputSHA256=actual)
                                            break
                                    elif args.identity_change:
                                        record = task_status(bottle, url)
                                        if record and record['status'] == 'Complete':
                                            data = output.read_bytes()
                                            old_count = sum(a == b for a, b in zip(data, server.original_body))
                                            new_count = sum(a == b for a, b in zip(data, server.fixture_state[0]))
                                            report.update(completedTask=record, outputSHA256=actual,
                                                          oldBytes=old_count, newBytes=new_count,
                                                          otherBytes=len(data)-old_count-new_count)
                                            raise RuntimeError('Original reported Complete with content different from current resource')
                            if report['transferPassed']:
                                break
                            time.sleep(0.2)
                        if not report['transferPassed'] and not report.get('identityConflictBlocked'):
                            raise RuntimeError('No matching completed fixture file within 25 seconds')
                        if args.pause_resume and not args.identity_change:
                            resumed = report['requests'][report['requestsBeforeResume']:]
                            report['resumedFromNonzeroOffsets'] = bool(resumed) and all(
                                entry['range'] and int(entry['range'].split('=')[1].split('-')[0]) > 0
                                for entry in resumed)
                            if not report['resumedFromNonzeroOffsets']:
                                raise RuntimeError('Resume did not use saved nonzero offsets')
                        if args.post_audit:
                            expected_body_hash = hashlib.sha256(POST_BODY).hexdigest()
                            report['expectedPostBodySHA256'] = expected_body_hash
                            report['postSemanticsPassed'] = bool(report['requests']) and all(
                                entry['method'] == 'POST' and entry['bodySHA256'] == expected_body_hash
                                and entry['bodyBytes'] == len(POST_BODY)
                                and entry['contentType'] == POST_CONTENT_TYPE for entry in report['requests'])
                            if not report['postSemanticsPassed'] or report['completedTask']['method'] != 'POST':
                                raise RuntimeError('POST method/body not preserved across requests or record')
                        if args.multi_task:
                            report['decoyUnchanged'] = (task_status(bottle, decoy_url) == report['decoyTask']
                                and hashlib.sha256(decoy_path.read_bytes()).hexdigest() == report['decoySHA256'])
                            if not report['decoyUnchanged']:
                                raise RuntimeError('Restoring target modified the other task')
                    break
            if not report['handshakePassed']:
                raise TimeoutError('Original bridge did not become ready')
    except Exception as error:
        report['error'] = str(error)
    finally:
        if guard is not None:
            guard.shutdown()
            guard.server_close()
            report['guardEvents'] = guard.events
        if server is not None:
            server.shutdown()
            server.server_close()
        if bottle.exists():
            # Explicit absolute bottle: never kill the default or another bottle.
            try:
                cleanup = subprocess.run(wine + ['--ux-app', 'wineserver', '-k'], env=env,
                                         capture_output=True, timeout=20)
                report['cleanupExit'] = cleanup.returncode
                waited = subprocess.run(wine + ['--ux-app', 'wineserver', '-w'], env=env,
                                        capture_output=True, timeout=20)
                report['cleanupWaitExit'] = waited.returncode
            except subprocess.TimeoutExpired as error:
                report['cleanupError'] = str(error)
        if proc is not None:
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                report['cleanupError'] = 'Engine launcher still running after bottle stop'
        report['sourceUnchanged'] = args.exe.read_bytes() == original
        (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    return 0 if (report['handshakePassed'] and report['sourceUnchanged']
                 and report.get('cleanupExit') == 0 and report.get('cleanupWaitExit') == 0
                 and 'cleanupError' not in report and 'error' not in report
                 and (not args.transfer or report.get('transferPassed') or report.get('identityConflictBlocked'))) else 1


if __name__ == '__main__':
    raise SystemExit(main())
