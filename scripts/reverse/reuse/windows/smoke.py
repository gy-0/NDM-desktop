#!/usr/bin/env python3
"""Isolated CrossOver smoke test, not a Windows acceptance test.

No download is submitted. Only a private copy's bridge port is changed.
The bottle and logs remain in the printed temporary directory for inspection.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time

EXPECTED = '60b06db7dfeb6fffb1be82f8ad059d61bdb1b1a3889439b56eaac162e64c0f37'
BIN = Path('/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin')


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
    args = parser.parse_args()
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
                    key = base64.b64encode(os.urandom(16)).decode()
                    conn.sendall(f'GET /download HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: neatextension.v1\r\n\r\n'.encode())
                    response = b''
                    while b'\r\n\r\n' not in response and len(response) < 8192:
                        block = conn.recv(2048)
                        if not block:
                            break
                        response += block
                    report['handshake'] = response.decode(errors='replace')
                    accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
                    if not response.startswith(b'HTTP/1.1 101') or accept not in response:
                        raise RuntimeError('Invalid WebSocket handshake')
                    report['handshakePassed'] = True
                    break
            if not report['handshakePassed']:
                raise TimeoutError('Original bridge did not become ready')
    except Exception as error:
        report['error'] = str(error)
    finally:
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
                 and 'cleanupError' not in report) else 1


if __name__ == '__main__':
    raise SystemExit(main())
