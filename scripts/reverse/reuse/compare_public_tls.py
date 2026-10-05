"""Opt-in same public archive check. Timings are observations, not a speed ranking."""
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import time

URL = 'https://www.python.org/ftp/python/3.13.0/Python-3.13.0.tgz'
EXPECTED = '12445c7b3db3126c41190bfdc1c8239c39c719404e844babbd015a1bc3fafcd4'
SIZE = 29186321


def compare_public_tls(host_path, root, original_submit, original_snapshot, original_port, free_port, proxy):
    workspace = root / 'public-comparison'
    workspace.mkdir()
    home, support, output = [workspace / name for name in ('home', 'support', 'downloads')]
    for directory in (home, support, output):
        directory.mkdir()
    control = workspace / 'control.tgz'
    subprocess.run(['curl', '--noproxy', '*', '--fail', '--silent', '--show-error',
                    '--max-time', '120', URL, '-o', str(control)], check=True)
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()
    assert control.stat().st_size == SIZE and digest(control) == EXPECTED
    port, bridge = free_port(), free_port()
    while bridge == port:
        bridge = free_port()
    host_path = Path(host_path).resolve(strict=True)
    def rpc(op, **fields):
        with socket.create_connection(('127.0.0.1', port), timeout=10) as conn:
            conn.sendall((json.dumps(dict(id=1, op=op, **fields)) + '\n').encode())
            with conn.makefile('r') as stream:
                for line in stream:
                    reply = json.loads(line)
                    if reply.get('id') == 1:
                        assert reply.get('ok'), reply
                        return reply
        raise RuntimeError('RPC closed without response')
    report = {'passed': False, 'url': URL, 'bytes': SIZE, 'expectedSHA256': EXPECTED,
              'hostSHA256': digest(host_path), 'cases': [], 'controlPath': str(control),
              'scope': 'One sequential original/current public HTTPS pair through the same pinned SOCKS relay; no UI or speed superiority claim',
              'measurementNotes': ['Original first, current second; network/CDN/cache order is uncontrolled.',
                                   'Original snapshot refresh 200 ms; current RPC polling 25 ms.',
                                   'Observed first progress and completion include sampling delay, not first packet or UI paint.'],
              'systemTrustChanged': False}
    env = dict(PATH='/usr/bin:/bin', HOME=str(home), CFFIXED_USER_HOME=str(home),
               NDM_SUPPORT_DIR=str(support), NDM_HOST_PORT=str(port),
               NDM_BRIDGE_PORT=str(bridge), NDM_DISABLE_LEGACY_BRIDGE='1')
    with (workspace / 'host.log').open('wb') as log:
        host = subprocess.Popen([str(host_path)], env=env, cwd=workspace, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 20
            while True:
                assert host.poll() is None, 'Host exited'
                try:
                    rpc('ping')
                    break
                except OSError:
                    assert time.monotonic() < deadline, 'Host startup timeout'
                    time.sleep(.05)
            assert rpc('list')['tasks'] == []
            rpc('updateSettings', maxConnections=4, smartConnections=False,
                httpProxyEnabled=False, socksProxyEnabled=True, socksProxyHost='127.0.0.1',
                socksProxyPort=proxy.port, useCategoryFolders=False)
            for engine in ('original', 'current'):
                time.sleep(.6)
                first_route = len(proxy.routes)
                started = time.monotonic()
                key = str(original_submit(URL, original_port)) if engine == 'original' else str(
                    rpc('add', url=URL, filename='current.tgz', folderPath=str(output), connections=4)['task']['id'])
                samples = []
                while time.monotonic() - started < 120:
                    if engine == 'original':
                        state = original_snapshot()
                        task = next((r for r in state.get('records', []) if str(r['id']) == key), None)
                        live = next((r for r in state.get('tasks', []) if str(r['id']) == key), {})
                        count = (live.get('engineProgress') or {}).get('completedBytes', 0)
                        complete = task and task['status'] == 'Complete'
                        assert not (task and str(task['status']).startswith('Error')), task
                        destination = Path(task['folderpath']) / task['filename'] if complete else None
                    else:
                        task = next(t for t in rpc('list')['tasks'] if str(t['id']) == key)
                        count, complete = task['completedBytes'], task['status'] == 'complete'
                        assert task['status'] != 'error', task
                        destination = Path(task['folderPath']) / task['filename'] if complete else None
                    samples.append({'elapsedMS': round((time.monotonic() - started) * 1000, 2),
                                    'bytes': SIZE if complete else count})
                    if complete:
                        assert destination.resolve().is_relative_to(root.resolve())
                        assert destination.stat().st_size == SIZE and digest(destination) == EXPECTED
                        time.sleep(.2)
                        routes = [dict(r) for r in proxy.routes[first_route:]]
                        assert routes and all(r['host'] == 'www.python.org' and r['port'] == 443 and not r.get('rejected') for r in routes)
                        assert any(r.get('bytesFromOrigin', 0) > 0 and r.get('bytesToOrigin', 0) > 0 for r in routes)
                        report['cases'].append({'engine': engine, 'taskID': key, 'output': str(destination),
                                                'sha256': EXPECTED, 'samples': samples, 'proxyRoutes': routes,
                                                'firstObservedProgressMS': next(s['elapsedMS'] for s in samples if s['bytes'] > 0),
                                                'completionObservedMS': samples[-1]['elapsedMS']})
                        break
                    time.sleep(.025)
                else:
                    raise TimeoutError(engine + ' public HTTPS completion')
            report['passed'] = True
        finally:
            report['allProxyRoutes'] = [dict(r) for r in proxy.routes]
            if host.poll() is None:
                host.terminate()
                host.wait(timeout=15)
            report['hostStopped'] = host.poll() is not None
            (workspace / 'report.json').write_text(json.dumps(report, indent=2))
    return report
