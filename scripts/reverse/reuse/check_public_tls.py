"""Opt-in public HTTPS smoke, with pinned SOCKS relay and an isolated release Host.

Small public file only; no system trust/proxy changes. Not a throughput benchmark.
"""
import hashlib
import argparse
import json
import pathlib
import socket
import subprocess
import tempfile
import time
from original_socks import SocksFixture

URL = 'https://www.python.org/static/img/python-logo.png'
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='ndm-public-tls-'))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[3] / 'native/.build/release/NDMHost')
HOST = parser.parse_args().host.resolve(strict=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

port, bridge = free_port(), free_port()
while port == bridge:
    bridge = free_port()
for name in ('home', 'downloads'):
    (ROOT / name).mkdir()
control = ROOT / 'control.png'
# --noproxy ensures this control does not inherit a shell proxy variable.
subprocess.run(['curl', '--noproxy', '*', '--fail', '--silent', '--show-error',
                '--max-time', '30', URL, '-o', str(control)], check=True)
assert control.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
expected = digest(control)
proxy = SocksFixture(443, pinned_host='www.python.org')
report = {'passed': False, 'root': str(ROOT), 'url': URL,
          'scope': 'Current release Host public trusted HTTPS; not original comparison, UI or throughput acceptance',
          'systemTrustChanged': False, 'controlSHA256': expected,
          'controlBytes': control.stat().st_size, 'hostPath': str(HOST), 'hostSHA256': digest(HOST), 'cases': []}

def rpc(op, **fields):
    with socket.create_connection(('127.0.0.1', port), timeout=5) as conn:
        conn.sendall((json.dumps(dict(id=1, op=op, **fields)) + '\n').encode())
        with conn.makefile('r') as stream:
            for line in stream:
                reply = json.loads(line)
                if reply.get('id') == 1:
                    assert reply.get('ok'), reply
                    return reply
    raise RuntimeError('RPC closed')

with (ROOT / 'host.log').open('wb') as log:
    host = subprocess.Popen([str(HOST)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
        env=dict(PATH='/usr/bin:/bin', HOME=str(ROOT/'home'), CFFIXED_USER_HOME=str(ROOT/'home'),
                 NDM_SUPPORT_DIR=str(ROOT/'support'), NDM_HOST_PORT=str(port),
                 NDM_BRIDGE_PORT=str(bridge), NDM_DISABLE_LEGACY_BRIDGE='1'))
    try:
        deadline = time.monotonic() + 20
        while True:
            assert host.poll() is None
            try:
                rpc('ping')
                break
            except OSError:
                assert time.monotonic() < deadline, 'Host startup timeout'
                time.sleep(.1)
        assert rpc('list')['tasks'] == []
        for name in ('direct', 'socks', 'socks-refused'):
            proxy.reject = name == 'socks-refused'
            first_route = len(proxy.routes)
            rpc('updateSettings', httpProxyEnabled=False, socksProxyEnabled=name != 'direct',
                socksProxyHost='127.0.0.1', socksProxyPort=proxy.port)
            started = time.monotonic()
            key = rpc('add', url=URL, filename=name+'.png', folderPath=str(ROOT/'downloads'))['task']['id']
            while time.monotonic() - started < 40:
                row = next(t for t in rpc('list')['tasks'] if t['id'] == key)
                if row['status'] in ('complete', 'error'):
                    break
                time.sleep(.05)
            case = {'name': name, 'status': row['status'], 'elapsedMS': round((time.monotonic()-started)*1000, 2),
                    'completedBytes': row['completedBytes'], 'errorText': row.get('errorText')}
            output = pathlib.Path(row['folderPath']) / row['filename']
            if output.is_file():
                case['outputSHA256'] = digest(output)
            # Successful completion can precede relay teardown by a few ms.
            time.sleep(.2)
            case['proxyRoutes'] = [dict(r) for r in proxy.routes[first_route:]]
            report['cases'].append(case)
            if name == 'socks-refused':
                assert row['status'] == 'error' and row['completedBytes'] == 0 and not output.exists(), case
                assert case['proxyRoutes'] and all(r['rejected'] for r in case['proxyRoutes']), case
            else:
                assert row['status'] == 'complete' and case.get('outputSHA256') == expected, case
                if name == 'direct':
                    assert not case['proxyRoutes'], case
                else:
                    assert case['proxyRoutes'] and all(r['host'] == 'www.python.org' and r['port'] == 443
                        and not r['rejected'] and r['bytesToOrigin'] > 0 and r['bytesFromOrigin'] > 0
                        for r in case['proxyRoutes']), case
        report['passed'] = True
    finally:
        try:
            if host.poll() is None:
                rpc('pauseAll')
        finally:
            if host.poll() is None:
                host.terminate()
                host.wait(timeout=15)
            proxy.close()
            report['hostStopped'] = host.poll() is not None
            (ROOT/'report.json').write_text(json.dumps(report, indent=2)+'\n')
            print(json.dumps(report, indent=2), flush=True)
assert report['passed'] and report['hostStopped']
