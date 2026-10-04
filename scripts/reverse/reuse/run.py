"""Direct-control experiment of an unchanged original download engine (macOS only).
Owns one signed copy, profile, loopback server and injected controller. Not a product backend.
"""
import argparse, base64, hashlib, http.server, json, os, pathlib, plistlib, re, shutil, signal, socket, struct, subprocess, tempfile, threading, time, uuid

parser = argparse.ArgumentParser()
parser.add_argument('--headless', action='store_true')
options = parser.parse_args()

SOURCE = pathlib.Path('/Applications/NeatDownloadManager.app')
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='ndm-original-reuse-'))
APP = pathlib.Path('/Applications') / ('NDMEngineProbe-' + uuid.uuid4().hex[:12] + '.app')
PROFILE, OUTPUT = ROOT / 'profile', ROOT / 'downloads'
PROFILE.mkdir(); OUTPUT.mkdir()
REPORT = {'passed': False, 'root': str(ROOT), 'scope': 'Original macOS 1.3 engine in isolated process; not integrated product or Windows proof'}
proc = None
server = None
requests = []
request_lock = threading.Lock()
payload = os.urandom(32 * 1024 * 1024)

def sha(data): return hashlib.sha256(data).hexdigest()
def wait(fn, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc and proc.poll() is not None: raise RuntimeError('Reference process exited: ' + str(proc.returncode))
        result = fn()
        if result: return result
        time.sleep(.05)
    raise TimeoutError(label)
def snapshot():
    try: return json.loads((ROOT / 'snapshot.json').read_text())
    except FileNotFoundError: return {}
def current_task(key): return next((t for t in snapshot().get('tasks', []) if t['key'] == key), None)
def command(operation, key):
    nonce = str(uuid.uuid4())
    temporary = ROOT / 'command.tmp'
    temporary.write_text(json.dumps({'nonce': nonce, 'operation': operation, 'task': key}))
    temporary.replace(ROOT / 'command.json')
    def reply():
        try:
            result = json.loads((ROOT / 'command-result.json').read_text())
            return result if result['nonce'] == nonce else None
        except FileNotFoundError: return None
    result = wait(reply, 'controller reply')
    assert result['ok'], result
    return result
def segment_files(key):
    work = pathlib.Path(snapshot()['support']) / key
    return {p.name: {'size': p.stat().st_size, 'sha256': sha(p.read_bytes())} for p in work.glob('seg.x*')}
def pause_and_verify(key):
    reply = command('pause', key)
    state = wait(lambda: (t if (t := current_task(key)) and not t['working'] else None), 'paused engine')
    before = segment_files(key)
    assert before and sum(p['size'] for p in before.values()) > 0
    time.sleep(1)
    assert segment_files(key) == before, 'writers continued after paused'
    return {'reply': reply, 'state': state, 'segments': before, 'stableForOneSecond': True}
def free_port():
    with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); return sock.getsockname()[1]
def text_hash(path):
    output = subprocess.check_output(['otool', '-s', '__TEXT', '__text', str(path)], text=True)
    return sha('\n'.join(line for line in output.splitlines() if re.match(r'^[0-9a-f]{16}\s', line)).encode())
class Server(http.server.ThreadingHTTPServer): daemon_threads = True
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/auth.bin':
            with request_lock: requests.append({'path': self.path, 'status': 401})
            self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="NDM isolated fixture"')
            self.send_header('Content-Length','0'); self.send_header('Connection','close'); self.end_headers()
            return
        if self.path == '/missing.bin':
            with request_lock: requests.append({'path': self.path, 'status': 404})
            self.send_response(404); self.send_header('Content-Length','0'); self.send_header('Connection','close'); self.end_headers()
            return
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
        start = int(match[1]) if match else 0
        end = min(int(match[2]), len(payload)-1) if match and match[2] else len(payload)-1
        with request_lock: requests.append({'time': time.time(), 'range': self.headers.get('Range'), 'start': start, 'end': end})
        self.send_response(206 if match else 200)
        self.send_header('Connection', 'close'); self.send_header('Content-Length', str(end-start+1)); self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Accept-Ranges', 'bytes'); self.send_header('ETag', '"original-engine-fixture"')
        if match: self.send_header('Content-Range', f'bytes {start}-{end}/{len(payload)}')
        self.end_headers()
        try:
            for offset in range(start, end+1, 16384):
                self.wfile.write(payload[offset:min(offset+16384,end+1)]); self.wfile.flush(); time.sleep(.035)
        except (BrokenPipeError, ConnectionResetError): pass

def submit(url, port):
    with socket.create_connection(('127.0.0.1', port), timeout=5) as sock:
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(f'GET /download HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: neatextension.v1\r\n\r\n'.encode())
        response = b''
        while b'\r\n\r\n' not in response: response += sock.recv(4096)
        assert b' 101 ' in response.split(b'\r\n')[0]
        expected = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert expected in response
        message = f'1:GET\r\n2:{url}\r\n6:normal\r\n'.encode(); mask = os.urandom(4)
        header = bytes([0x81, 0x80|len(message)]) if len(message)<126 else bytes([0x81,0xfe])+struct.pack('!H',len(message))
        sock.sendall(header+mask+bytes(byte^mask[i%4] for i,byte in enumerate(message)))
        time.sleep(.3)

try:
    original = SOURCE/'Contents/MacOS/NeatDownloadManager'
    REPORT['sourceSHA256'] = sha(original.read_bytes())
    assert REPORT['sourceSHA256'] == '08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101', 'Unverified original binary: inspect ABI before running this adapter'
    REPORT['sourceTextSHA256'] = text_hash(original)
    shutil.copytree(SOURCE, APP, symlinks=True)
    info_path = APP/'Contents/Info.plist'; info = plistlib.loads(info_path.read_bytes())
    info['CFBundleIdentifier'] = 'org.ndm.reuse.' + uuid.uuid4().hex
    info['CFBundleName'] = 'NDM Engine Research'
    info_path.write_bytes(plistlib.dumps(info))
    subprocess.run(['codesign','--force','--deep','--sign','-',str(APP)], check=True, capture_output=True)
    assert text_hash(APP/'Contents/MacOS/NeatDownloadManager') == REPORT['sourceTextSHA256']
    library = ROOT/'probe.dylib'
    subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','AppKit',str(pathlib.Path(__file__).with_name('probe.m')),'-o',str(library)], check=True, capture_output=True)
    policy = ROOT/'isolation.sb'
    # This host's real profile is read/write protected; the only network allowed is loopback.
    user_home = str(pathlib.Path.home())
    policy.write_text(f'''(version 1)
(allow default)
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny file-write* (subpath "{user_home}"))
(deny file-read* (subpath "{user_home}/Library/Application Support/com.NeatDownloadManager"))
(deny file-read* (literal "{user_home}/Library/Preferences/com.NeatDownloadManager.plist"))
''')
    port = free_port()
    arguments = ['sandbox-exec','-f',str(policy),'/usr/bin/env',f'DYLD_INSERT_LIBRARIES={library}',f'NDM_REUSE_DIR={ROOT}',f'NDM_REUSE_PORT={port}',f'NDM_REUSE_HEADLESS={int(options.headless)}',f'HOME={PROFILE}',f'CFFIXED_USER_HOME={PROFILE}',str(APP/'Contents/MacOS/NeatDownloadManager'),'-MaxConnections','4','-CompletionDialog','2','-AppAutoStart','2','-DownloadDirectory',str(OUTPUT)+'/', '-CategoryFolders','2']
    def launch():
        global proc
        proc = subprocess.Popen(arguments, stdout=open(ROOT/'process.log','ab'), stderr=subprocess.STDOUT)
        wait(lambda: snapshot().get('pid') == proc.pid, 'instrumented engine startup')
        assert pathlib.Path(snapshot()['support']).is_relative_to(PROFILE)
        assert pathlib.Path(snapshot()['output']) == OUTPUT
        print(json.dumps({'stage':'launched','pid':proc.pid,'root':str(ROOT)}),flush=True)
    server = Server(('127.0.0.1',0), Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    launch()
    assert snapshot()['recordCount'] == 0
    submit(f'http://127.0.0.1:{server.server_port}/reuse.bin',port)
    task = wait(lambda:next((t for t in snapshot().get('tasks',[]) if t['working'] and t['percent']>2),None),'first progress')
    key = task['key']; REPORT['taskID'] = task['id']
    REPORT['pause'] = pause_and_verify(key)
    REPORT['resume'] = command('resume',key)
    wait(lambda:(t if (t:=current_task(key)) and t['working'] and t['percent']>8 else None),'resumed bytes')
    REPORT['beforeRestart'] = pause_and_verify(key)
    if options.headless:
        REPORT['headlessBeforeRestart'] = snapshot()
        assert snapshot()['visibleSamples'] == 0
    first_pid = proc.pid
    proc.terminate(); proc.wait(timeout=10)
    launch()
    assert proc.pid != first_pid
    assert snapshot()['recordCount'] == 1
    assert not snapshot()['tasks'], 'test requires restoring a persisted record, not retaining an old engine object'
    assert segment_files(key) == REPORT['beforeRestart']['segments']
    REPORT['restore'] = command('resume',key)
    assert REPORT['restore'].get('loadedFromRecord') is True
    wait(lambda:any(t['key']==key and t['working'] for t in snapshot()['tasks']),'restored engine')
    # Original creates the final path while merging; wait for its durable Complete state.
    wait(lambda:any(str(row['id'])==key and row['status']=='Complete' for row in snapshot().get('records',[])),'completed state',120)
    final = OUTPUT/'reuse.bin'
    assert final.stat().st_size == len(payload)
    assert sha(final.read_bytes()) == sha(payload)
    if options.headless:
        completed = snapshot()
        assert completed['headless'] and completed['visibleSamples'] == 0 and completed['presentationRequests'] > 0, completed
        REPORT['headlessCompletion'] = completed
        submit(f'http://127.0.0.1:{server.server_port}/missing.bin',port)
        wait(lambda: any(r.get('status') == 404 for r in requests), '404 request')
        wait(lambda: any(str(r['id']) != key and str(r['status']).startswith('Error') for r in snapshot().get('records', [])), '404 error record')
        time.sleep(1)
        failure = snapshot()
        assert time.time() - failure['time'] < 2, 'hidden error blocked snapshot delivery'
        assert failure['visibleSamples'] == 0, failure
        REPORT['http404Observation'] = failure
        submit(f'http://127.0.0.1:{server.server_port}/auth.bin',port)
        auth = wait(lambda: next((t for t in snapshot().get('tasks',[]) if t.get('authenticating') is True), None), 'authentication required')
        REPORT['authenticationRequired'] = snapshot()
        REPORT['authenticationStayedHidden'] = snapshot()['visibleSamples'] == 0
        assert REPORT['authenticationStayedHidden']
        assert snapshot()['pendingAuthSheets'] == 1
        assert time.time() - snapshot()['time'] < 2
        REPORT['authenticationCancel'] = command('cancel-auth',auth['key'])
        wait(lambda: not any(t.get('authenticating') is True for t in snapshot().get('tasks',[])), 'authentication cancelled')
        wait(lambda: any(str(r['id']) == auth['key'] and str(r['status']).startswith('Error') for r in snapshot().get('records',[])), 'authentication error record')
        time.sleep(1)
        REPORT['authenticationCancelled'] = snapshot()
        assert snapshot()['pendingAuthSheets'] == 0 and snapshot()['completedAuthSheets'] == 1
        assert snapshot()['visibleSamples'] == 0
        assert REPORT['authenticationCancel']['viaSheetCompletion']
        assert time.time() - snapshot()['time'] < 2
    REPORT.update({'passed':True,'sha256':sha(payload),'bytes':len(payload),'requests':requests,'finalState':snapshot(),'originalTextUnchanged':True})
    print(json.dumps({'stage':'passed','root':str(ROOT),'bytes':len(payload)}),flush=True)
except BaseException as error:
    REPORT['error'] = repr(error)
    raise
finally:
    if proc and proc.poll() is None: proc.terminate(); proc.wait(timeout=10)
    if server: server.shutdown();server.server_close()
    REPORT['sourceUnchanged'] = sha((SOURCE/'Contents/MacOS/NeatDownloadManager').read_bytes()) == REPORT.get('sourceSHA256')
    REPORT['processStopped'] = proc is None or proc.poll() is not None
    # Only this freshly created, known test copy is moved to Trash; evidence stays in ROOT.
    try:
        if APP.exists(): subprocess.run(['/usr/bin/trash',str(APP)],check=True)
        REPORT['copyTrashed'] = not APP.exists()
    finally:
        (ROOT/'report.json').write_text(json.dumps(REPORT,indent=2))
    print('Report:',ROOT/'report.json',flush=True)
