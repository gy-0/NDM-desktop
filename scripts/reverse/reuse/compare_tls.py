"""Direct engine certificate rejection, with a privately trusted fixture control."""
import hashlib
import http.client
import json
from pathlib import Path
import socket
import ssl
import subprocess
import time


def compare_tls(host_path, root, submit, snapshot, fixture_port, original_port,
                requests, payload, free_port, trusted_context):
    workspace = root / 'direct-tls'
    workspace.mkdir()
    home, support, output = [workspace / name for name in ('home', 'support', 'downloads')]
    for path in (home, support, output):
        path.mkdir()
    # This control trusts only this fixture in Python. Neither engine receives it.
    control = http.client.HTTPSConnection('127.0.0.1', fixture_port,
                                        context=trusted_context, timeout=15)
    control.request('GET', '/tls-control.bin')
    response = control.getresponse()
    body = response.read()
    assert response.status == 200 and body == payload
    control.close()
    untrusted = http.client.HTTPSConnection('127.0.0.1', fixture_port, timeout=15)
    try:
        untrusted.request('GET', '/tls-untrusted-control.bin')
        raise AssertionError('Default Python trust unexpectedly accepted fixture certificate')
    except ssl.SSLCertVerificationError:
        pass
    finally:
        untrusted.close()
    port, bridge = free_port(), free_port()
    while port == bridge:
        bridge = free_port()
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home),
           'CFFIXED_USER_HOME': str(home), 'TMPDIR': str(workspace),
           'NDM_SUPPORT_DIR': str(support), 'NDM_HOST_PORT': str(port),
           'NDM_BRIDGE_PORT': str(bridge), 'NDM_DISABLE_LEGACY_BRIDGE': '1'}
    sequence = 0

    def rpc(op, **fields):
        nonlocal sequence
        sequence += 1
        with socket.create_connection(('127.0.0.1', port), timeout=5) as conn:
            conn.sendall((json.dumps({'id': sequence, 'op': op, **fields}) + '\n').encode())
            with conn.makefile('r') as stream:
                for line in stream:
                    reply = json.loads(line)
                    if reply.get('id') == sequence:
                        assert reply.get('ok'), reply
                        return reply
        raise RuntimeError('RPC closed')

    report = {'passed': False, 'cases': [], 'systemTrustChanged': False,
              'scope': 'Direct self-signed localhost TLS only; not trusted public TLS, proxy or UI acceptance',
              'defaultTrustControlRejected': True,
              'fixtureControlSHA256': hashlib.sha256(body).hexdigest(),
              'hostSHA256': hashlib.sha256(Path(host_path).read_bytes()).hexdigest()}
    with (workspace / 'host.log').open('wb') as log:
        host = subprocess.Popen([str(Path(host_path).resolve())], env=env, cwd=workspace,
                                stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 20
            while True:
                assert host.poll() is None, 'Host exited'
                try:
                    rpc('ping')
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(.1)
            assert rpc('list')['tasks'] == []
            for engine in ('original', 'current'):
                path = f'/tls-{engine}.bin'
                url = f'https://127.0.0.1:{fixture_port}{path}'
                start = time.monotonic()
                key = str(submit(url, original_port)) if engine == 'original' else str(
                    rpc('add', url=url, filename=path[1:], folderPath=str(output))['task']['id'])
                terminal = False
                while time.monotonic() - start < 20:
                    rows = snapshot().get('records', []) if engine == 'original' else rpc('list')['tasks']
                    row = next((r for r in rows if str(r['id']) == key), {})
                    status = str(row.get('status', ''))
                    if status.lower() == 'complete' or status.lower().startswith('error'):
                        terminal = True
                        break
                    time.sleep(.1)
                observed = [r for r in requests if r.get('path') == path]
                case = {'engine': engine, 'terminal': terminal, 'task': row,
                        'elapsedMS': round((time.monotonic() - start) * 1000, 2),
                        'httpRequests': observed,
                        'rejectedBeforeHTTP': terminal and status.lower().startswith('error') and not observed}
                if status.lower() == 'complete':
                    destination = Path(row['folderpath'] if engine == 'original' else row['folderPath']) / row['filename']
                    case['outputSHA256'] = hashlib.sha256(destination.read_bytes()).hexdigest()
                    assert case['outputSHA256'] == report['fixtureControlSHA256']
                if engine == 'current':
                    case['noPayloadWritten'] = row.get('completedBytes') == 0 and not any(output.iterdir())
                report['cases'].append(case)
                print(json.dumps(case), flush=True)
            report['passed'] = report['cases'][-1]['rejectedBeforeHTTP'] and report['cases'][-1]['noPayloadWritten']
        finally:
            if host.poll() is None:
                try:
                    rpc('pauseAll')
                finally:
                    host.terminate()
                    host.wait(timeout=15)
            report['hostStopped'] = host.poll() is not None
            (workspace / 'report.json').write_text(json.dumps(report, indent=2))
    return report
