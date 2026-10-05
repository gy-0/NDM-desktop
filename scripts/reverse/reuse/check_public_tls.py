"""Opt-in public HTTPS smoke, with pinned SOCKS relay and an isolated release Host.

Small public file by default, optional fixed-release archive pause/resume.
No system trust/proxy changes. Not a throughput benchmark.
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
parser.add_argument('--expect-proxy-diagnostic', action='store_true')
parser.add_argument('--pause-resume', action='store_true', help='Use Python 3.13.0 source archive and verify durable pause/resume')
parser.add_argument('--disconnect', action='store_true', help='Drop one non-initial SOCKS tunnel after 1 MiB of encrypted response bytes')
parser.add_argument('--crash-after-resume', action='store_true', help='Kill only the owned Host after new post-checkpoint HTTPS bytes, then restore and finish')
parser.add_argument('--restart-after-pause', action='store_true', help='Exit and relaunch the isolated Host before resuming')
options = parser.parse_args()
if options.crash_after_resume and (not options.pause_resume or options.restart_after_pause):
    parser.error('--crash-after-resume requires --pause-resume and excludes --restart-after-pause')
if options.restart_after_pause and not options.pause_resume:
    parser.error('--restart-after-pause requires --pause-resume')
if options.pause_resume and options.disconnect:
    parser.error('Choose pause/resume or forced disconnection separately')
HOST = options.host.resolve(strict=True)
large_file = options.pause_resume or options.disconnect
if large_file:
    URL = 'https://www.python.org/ftp/python/3.13.0/Python-3.13.0.tgz'
suffix = '.tgz' if large_file else '.png'

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
control = ROOT / ('control' + suffix)
# --noproxy ensures this control does not inherit a shell proxy variable.
subprocess.run(['curl', '--noproxy', '*', '--fail', '--silent', '--show-error',
                '--max-time', '120', URL, '-o', str(control)], check=True)
assert control.read_bytes().startswith(b'\x1f\x8b' if large_file else b'\x89PNG\r\n\x1a\n')
expected = digest(control)
if large_file:
    assert control.stat().st_size == 29186321
    assert expected == '12445c7b3db3126c41190bfdc1c8239c39c719404e844babbd015a1bc3fafcd4'
proxy = SocksFixture(443, pinned_host='www.python.org', disconnect_after_bytes=1024*1024 if options.disconnect else None)
report = {'passed': False, 'root': str(ROOT), 'url': URL,
          'scope': 'Current release Host public trusted HTTPS; not original comparison, UI or throughput acceptance',
          'systemTrustChanged': False, 'controlSHA256': expected,
          'pauseResume': options.pause_resume,
          'forcedDisconnect': options.disconnect,
          'restartAfterPause': options.restart_after_pause,
          'crashAfterResume': options.crash_after_resume,
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
    environment = dict(PATH='/usr/bin:/bin', HOME=str(ROOT/'home'), CFFIXED_USER_HOME=str(ROOT/'home'),
                 NDM_SUPPORT_DIR=str(ROOT/'support'), NDM_HOST_PORT=str(port),
                 NDM_BRIDGE_PORT=str(bridge), NDM_DISABLE_LEGACY_BRIDGE='1')
    def launch():
        return subprocess.Popen([str(HOST)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=environment)
    host = launch()
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
                socksProxyHost='127.0.0.1', socksProxyPort=proxy.port, maxConnections=4, smartConnections=False)
            started = time.monotonic()
            key = rpc('add', url=URL, filename=name+suffix, folderPath=str(ROOT/'downloads'), connections=4)['task']['id']
            pause = None
            crash = None
            while time.monotonic() - started < (120 if large_file else 40):
                row = next(t for t in rpc('list')['tasks'] if t['id'] == key)
                if row['status'] in ('complete', 'error'):
                    break
                if (options.crash_after_resume and pause and crash is None
                        and row['status'] == 'downloading'
                        and row['completedBytes'] > pause['durableBytes'] + 65536):
                    old_pid = host.pid
                    host.kill()  # Popen handle of this harness's isolated child only.
                    host.wait(timeout=15)
                    assert host.returncode == -9
                    crash_receipt = json.loads((work/'offset-storage-v2.json').read_text())
                    crash_durable = sum(r['durablePrefix'] for r in crash_receipt['ranges'])
                    assert crash_durable >= pause['durableBytes'], 'Lost acknowledged checkpoint'
                    crashed_files = snapshot()
                    log_path = work/'LogFile.txt'
                    log_offset = log_path.stat().st_size
                    routes_before_crash = len(proxy.routes)
                    host = launch()
                    deadline = time.monotonic() + 20
                    while True:
                        assert host.poll() is None, 'Crash recovery Host exited'
                        try:
                            rpc('ping')
                            break
                        except OSError:
                            assert time.monotonic() < deadline, 'Crash recovery startup timeout'
                            time.sleep(.1)
                    restored = next(t for t in rpc('list')['tasks'] if t['id'] == key)
                    assert restored['status'] == 'incomplete', restored
                    assert 0 < restored['completedBytes'] <= crash_durable, restored
                    assert snapshot() == crashed_files, 'Startup changed owned interrupted storage'
                    crash = {'oldPID': old_pid, 'oldExitCode': -9, 'newPID': host.pid,
                             'beforeCrashBytes': row['completedBytes'], 'crashDurableBytes': crash_durable,
                             'restoredStatus': restored['status'], 'restoredCompletedBytes': restored['completedBytes'],
                             'storageUnchangedAtStartup': True, 'logOffset': log_offset,
                             'routesBeforeRestartResume': routes_before_crash}
                    rpc('resume', taskID=key)
                if options.pause_resume and name != 'socks-refused' and pause is None and row['completedBytes'] >= 1024*1024:
                    rpc('pause', taskID=key)
                    row = next(t for t in rpc('list')['tasks'] if t['id'] == key)
                    assert row['status'] == 'paused', row
                    work = ROOT/'support'/str(key)
                    receipt = json.loads((work/'offset-storage-v2.json').read_text())
                    assert pathlib.Path(receipt['parentPath']).resolve() == (ROOT/'downloads').resolve()
                    assert pathlib.Path(receipt['partialName']).name == receipt['partialName']
                    partial = ROOT/'downloads'/receipt['partialName']
                    def snapshot():
                        files = {str(p.relative_to(work)): {'bytes': p.stat().st_size, 'sha256': digest(p)}
                                 for p in work.rglob('*') if p.is_file() and p.name != 'LogFile.txt'}
                        files['payload'] = {'bytes': partial.stat().st_size, 'sha256': digest(partial)}
                        return files
                    before = snapshot()
                    durable = sum(r['durablePrefix'] for r in receipt['ranges'])
                    assert 0 < durable < control.stat().st_size, receipt
                    assert len(receipt['ranges']) >= 2, 'Fixture did not exercise a segmented plan'
                    time.sleep(1)
                    assert snapshot() == before, 'Paused storage changed'
                    pause = {'stableForOneSecond': True, 'durableBytes': durable, 'ranges': receipt['ranges'],
                             'pausedFiles': before, 'routesBeforeResume': len(proxy.routes)-first_route}
                    if options.restart_after_pause:
                        old_pid = host.pid
                        host.terminate()
                        host.wait(timeout=15)
                        stopped_code = host.returncode
                        assert snapshot() == before, 'Shutdown changed paused storage'
                        host = launch()
                        deadline = time.monotonic() + 20
                        while True:
                            assert host.poll() is None, 'Restarted Host exited'
                            try:
                                rpc('ping')
                                break
                            except OSError:
                                assert time.monotonic() < deadline, 'Restart timeout'
                                time.sleep(.1)
                        restored = next(t for t in rpc('list')['tasks'] if t['id'] == key)
                        assert restored['status'] == 'paused', restored
                        assert 0 < restored['completedBytes'] <= durable, restored
                        assert snapshot() == before, 'Startup changed paused storage'
                        pause['restart'] = {'oldPID': old_pid, 'oldExitCode': stopped_code,
                                            'newPID': host.pid, 'restoredStatus': restored['status'],
                                            'restoredCompletedBytes': restored['completedBytes'],
                                            'storageUnchanged': True}
                    resumed = time.monotonic()
                    rpc('resume', taskID=key)
                time.sleep(.05)
            case = {'name': name, 'status': row['status'], 'elapsedMS': round((time.monotonic()-started)*1000, 2),
                    'completedBytes': row['completedBytes'], 'errorText': row.get('errorText'),
                    'diagnostic': row.get('diagnostic')}
            if pause:
                pause['resumeToCompletionMS'] = round((time.monotonic()-resumed)*1000, 2)
                pause['routesAfterResume'] = len(proxy.routes)-first_route-pause['routesBeforeResume']
                case['pauseResume'] = pause
            if options.crash_after_resume and name != 'socks-refused':
                assert crash is not None, 'Completed without exercising active crash'
                recovery_log = (work/'LogFile.txt').read_bytes()[crash['logOffset']:].decode()
                import re
                starts = [int(value) for value in re.findall(r'Sending Http-GET .* Range = (\d+)-', recovery_log)]
                assert starts and all(value > 0 for value in starts), 'Recovery restarted from zero or lacked ranged requests'
                crash['recoveryRangeStarts'] = starts
                crash['routesAfterRestartResume'] = len(proxy.routes) - crash['routesBeforeRestartResume']
                if name == 'socks':
                    assert crash['routesAfterRestartResume'] > 0
                case['activeCrash'] = crash
            if large_file and name != 'socks-refused':
                case['engineLog'] = (ROOT/'support'/str(key)/'LogFile.txt').read_text()
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
                if options.expect_proxy_diagnostic:
                    assert row['errorText'] == '#diag:proxyConnectionFailed', case
                    assert row['diagnostic']['primaryAction'] == 'retry', case
                    assert row['diagnostic']['title'] in ('Could not connect through the proxy', '无法通过代理建立连接'), case
            else:
                assert row['status'] == 'complete' and case.get('outputSHA256') == expected, case
                if options.pause_resume:
                    assert pause is not None, 'Download completed without exercising pause/resume'
                    if name == 'socks':
                        assert pause['routesAfterResume'] > 0, 'Resume must create a new SOCKS route'
                if name == 'direct':
                    assert not case['proxyRoutes'], case
                else:
                    assert case['proxyRoutes'] and all(r['host'] == 'www.python.org' and r['port'] == 443
                        and not r['rejected']
                        for r in case['proxyRoutes']), case
                    assert any(r['bytesToOrigin'] > 0 and r['bytesFromOrigin'] > 0 for r in case['proxyRoutes']), case
                    if not options.pause_resume:
                        assert all(r['bytesToOrigin'] > 0 and r['bytesFromOrigin'] > 0 for r in case['proxyRoutes']), case
                    if options.disconnect:
                        faults = [r for r in case['proxyRoutes'] if r.get('forcedDisconnectMonotonic')]
                        assert len(faults) == 1 and faults[0]['bytesFromOrigin'] >= 1024*1024, case
                        assert any(r['connectedMonotonic'] > faults[0]['forcedDisconnectMonotonic']
                                   and r['bytesFromOrigin'] > 0 for r in case['proxyRoutes']), case
                        case['disconnectToCompletionMS'] = round((started+case['elapsedMS']/1000-faults[0]['forcedDisconnectMonotonic'])*1000, 2)
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
