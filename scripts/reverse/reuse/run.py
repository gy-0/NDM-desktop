"""Direct-control experiment of an unchanged original download engine (macOS only).
Owns one signed copy, profile, loopback server and injected controller. Not a product backend.
"""
from identity_guard import IdentityGuard
from receipts import Receipts
import ssl
import argparse, base64, hashlib, http.server, json, os, pathlib, plistlib, re, shutil, signal, socket, struct, subprocess, tempfile, threading, time, uuid

parser = argparse.ArgumentParser()
parser.add_argument('--headless', action='store_true')
parser.add_argument('--audit-original-socks', action='store_true')
parser.add_argument('--original-proxy-type', type=int, default=1)
parser.add_argument('--compare-socks', action='store_true')
parser.add_argument('--compare-disconnect', action='store_true', help='Drop one established ranged worker response per comparison task')
parser.add_argument('--compare-redirects', action='store_true', help='Compare a two-hop delayed redirect chain instead of direct origins')
parser.add_argument('--compare-pause', action='store_true', help='Pause at 25 percent, verify stable partial files, then resume each comparison')
parser.add_argument('--compare-size-mib', type=int, default=32, help='Synthetic comparison payload size, 1–256 MiB (comparison mode only)')
parser.add_argument('--compare-host', type=pathlib.Path, help='Compare the original with this release NDMHost using one fixture')
parser.add_argument('--desktop-session', type=pathlib.Path, help='Bundled desktop-session.mjs; own engine lifecycle through desktop code')
parser.add_argument('--desktop-control', type=pathlib.Path, help='Bundled desktop-control.mjs; exercise the desktop TypeScript transport')
parser.add_argument('--identity-change', action='store_true', help='audit same-size replacement across restart; fails on mixed bytes')
parser.add_argument('--identity-guard', action='store_true')
parser.add_argument('--tls-upstream', action='store_true')
parser.add_argument('--tls-via-socks', action='store_true')
parser.add_argument('--compare-untrusted-tls', action='store_true', help='Direct self-signed TLS rejection comparison; system trust unchanged')
parser.add_argument('--post-audit', action='store_true')
parser.add_argument('--restart-guard', action='store_true')
options = parser.parse_args()
if options.compare_socks and (not options.compare_host or options.compare_untrusted_tls or options.tls_upstream or options.identity_guard): parser.error('--compare-socks requires a plain --compare-host fixture')
if options.tls_via_socks and not options.compare_untrusted_tls: parser.error('--tls-via-socks requires --compare-untrusted-tls')
if options.audit_original_socks and any([options.compare_host, options.identity_guard, options.identity_change, options.tls_upstream, options.compare_untrusted_tls, options.desktop_session, options.desktop_control, options.post_audit, options.restart_guard]): parser.error('--audit-original-socks is a separate original-only fixture')
if not 1 <= options.compare_size_mib <= 256: parser.error('--compare-size-mib must be 1–256')
if options.compare_disconnect and (not options.compare_host or options.compare_redirects or options.compare_pause): parser.error('--compare-disconnect requires --compare-host and cannot combine with redirects/pause')
if options.compare_redirects and not options.compare_host: parser.error('--compare-redirects requires --compare-host')
if options.compare_pause and not options.compare_host: parser.error('--compare-pause requires --compare-host')
if options.compare_size_mib != 32 and not options.compare_host: parser.error('--compare-size-mib requires --compare-host')
if options.restart_guard and not options.identity_guard: parser.error('--restart-guard requires --identity-guard')
if options.post_audit and options.identity_guard: parser.error('POST audit currently requires direct original-engine transport')
if options.compare_untrusted_tls and (not options.compare_host or options.identity_guard or options.tls_upstream or options.compare_pause or options.compare_redirects or options.compare_disconnect): parser.error('--compare-untrusted-tls requires --compare-host without other scenario flags')
if options.tls_upstream and not options.identity_guard: parser.error('--tls-upstream requires --identity-guard')

SOURCE = pathlib.Path('/Applications/NeatDownloadManager.app')
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='ndm-original-reuse-'))
APP = pathlib.Path('/Applications') / ('NDMEngineProbe-' + uuid.uuid4().hex[:12] + '.app')
PROFILE, OUTPUT = ROOT / 'profile', ROOT / 'downloads'
PROFILE.mkdir(); OUTPUT.mkdir()
REPORT = {'passed': False, 'root': str(ROOT), 'scope': 'Original macOS 1.3 engine in isolated process; not integrated product or Windows proof'}
proc = None
server = None
guard = None
proxy_fixture = None
class GuardAuditComplete(Exception): pass
class ComparisonComplete(Exception): pass
class LostAcknowledgement(Exception): pass
receipts = Receipts(ROOT/"submission-receipts.json")
requests = []
request_lock = threading.Lock()
faulted_paths = set()
last_submission = 0.0
submissions = []
payload = os.urandom((1 if options.audit_original_socks else options.compare_size_mib) * 1024 * 1024)
post_body = b'name=fixture&unicode=%E4%B8%AD&repeat=1&repeat=2'
original_payload = payload
resource_version = 1

def sha(data): return hashlib.sha256(data).hexdigest()
def wait(fn, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc and proc.poll() is not None: raise RuntimeError('Reference process exited: ' + str(proc.returncode))
        result = fn()
        if result: return result
        time.sleep(.05)
    raise TimeoutError(label)
def engine_pid():
    if not options.desktop_session: return proc.pid
    try:
        ready = json.loads((ROOT/'session-ready.json').read_text())
        return ready['enginePID'] if ready['wrapperPID'] == proc.pid else None
    except FileNotFoundError: return None
def stop_engine():
    wrapper_pid = proc.pid
    proc.terminate(); proc.wait(timeout=35)
    if options.desktop_session:
        stopped = json.loads((ROOT/f'session-stopped-{wrapper_pid}.json').read_text())
        assert stopped['status'] == 'down', stopped
        REPORT.setdefault('desktopSessionStops', []).append(stopped)
def snapshot():
    try: return json.loads((ROOT / 'snapshot.json').read_text())
    except FileNotFoundError: return {}
def desktop_snapshot():
    if not options.desktop_control: return None
    request = {'directory': str(ROOT), 'operation': 'snapshot', 'expectedPID': engine_pid()}
    result = json.loads(subprocess.check_output(['node', str(options.desktop_control.resolve())], input=json.dumps(request).encode(), timeout=20))
    REPORT.setdefault('desktopSnapshots', []).append(result)
    return result
def current_task(key): return next((t for t in snapshot().get('tasks', []) if t['key'] == key), None)
def command(operation, key, expected_ok=True, **fields):
    if options.desktop_control:
        request = {'directory': str(ROOT), 'operation': operation, 'task': key}
        if operation == 'submit-auth': request['credentials'] = fields
        result = json.loads(subprocess.check_output(['node', str(options.desktop_control.resolve())], input=json.dumps(request).encode(), timeout=20))
        assert result['ok'] is expected_ok, result
        REPORT['desktopControlReplies'] = REPORT.get('desktopControlReplies', 0) + 1
        return result
    nonce = str(uuid.uuid4())
    temporary = ROOT / 'command.tmp'
    temporary.write_text(json.dumps({'nonce': nonce, 'operation': operation, 'task': key, **fields}))
    temporary.replace(ROOT / 'command.json')
    def reply():
        try:
            result = json.loads((ROOT / 'command-result.json').read_text())
            return result if result['nonce'] == nonce else None
        except FileNotFoundError: return None
    result = wait(reply, 'controller reply')
    assert result['ok'] is expected_ok, result
    return result
def segment_files(key):
    work = pathlib.Path(snapshot()['support']) / key
    return {p.name: {'size': p.stat().st_size, 'sha256': sha(p.read_bytes())} for p in work.glob('seg.x*')}
def pause_and_verify(key):
    started = time.monotonic()
    reply = command('pause', key)
    acknowledged = time.monotonic()
    assert reply.get('settled') is True and reply['workingAfter'] is False, reply
    state = wait(lambda: (t if (t := current_task(key)) and not t['working'] else None), 'paused engine')
    before = segment_files(key)
    assert before and sum(p['size'] for p in before.values()) > 0
    time.sleep(1)
    assert segment_files(key) == before, 'writers continued after paused'
    mapped = desktop_snapshot()
    if mapped:
        row = next(t for t in mapped['tasks'] if str(t['id']) == key)
        assert row['status'] == 'paused' and row['bytesPerSecond'] == 0, row
        assert row['completedBytes'] == state['engineProgress']['completedBytes'], row
    return {'reply': reply, 'state': state, 'segments': before, 'stableForOneSecond': True, 'pauseAcknowledgedMS': round((acknowledged-started)*1000,2)}
def free_port():
    with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); return sock.getsockname()[1]
def text_hash(path):
    output = subprocess.check_output(['otool', '-s', '__TEXT', '__text', str(path)], text=True)
    return sha('\n'.join(line for line in output.splitlines() if re.match(r'^[0-9a-f]{16}\s', line)).encode())
class Server(http.server.ThreadingHTTPServer): daemon_threads = True
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length','0')))
        valid = self.path == '/post.bin' and body == post_body
        with request_lock: requests.append({'path':self.path,'method':'POST','bodySHA256':sha(body),'bodyLength':len(body),'validBody':valid,'range':self.headers.get('Range')})
        if not valid:
            self.send_response(400);self.send_header('Content-Length','0');self.send_header('Connection','close');self.end_headers();return
        self.do_GET()
    def do_HEAD(self): self.do_GET()
    def do_GET(self):
        if self.path == '/post.bin' and self.command != 'POST':
            with request_lock: requests.append({'path':self.path,'method':self.command,'rejected':True})
            self.send_response(405);self.send_header('Content-Length','0');self.send_header('Connection','close');self.end_headers();return
        protected = self.path in ['/auth-a.bin', '/auth-b.bin']
        authenticated = self.headers.get('Authorization') == 'Basic ' + base64.b64encode(b'fixture:synthetic-password').decode()
        if protected:
            with request_lock: requests.append({'path':self.path,'authenticated':authenticated})
        if self.path == '/auth.bin' or (protected and not authenticated):
            with request_lock: requests.append({'path': self.path, 'status': 401})
            self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="NDM isolated fixture"')
            self.send_header('Content-Length','0'); self.send_header('Connection','close'); self.end_headers()
            return
        if self.path.startswith('/missing'):
            with request_lock: requests.append({'path': self.path, 'status': 404})
            self.send_response(404); self.send_header('Content-Length','0'); self.send_header('Connection','close'); self.end_headers()
            return
        if options.compare_redirects and self.path.startswith(('/compare/redirect-', '/compare/hop-')):
            target = self.path.replace('/compare/redirect-', '/compare/hop-', 1) if self.path.startswith('/compare/redirect-') else self.path.replace('/compare/hop-', '/compare/object-', 1)
            with request_lock: requests.append({'monotonic':time.monotonic(),'path':self.path,'method':self.command,'range':self.headers.get('Range'),'status':302,'location':target})
            time.sleep(.15)
            self.send_response(302); self.send_header('Location',target); self.send_header('Content-Length','0'); self.send_header('Connection','close'); self.end_headers()
            return
        body = payload
        etag = f'"original-engine-fixture-{resource_version}"'
        if self.headers.get('If-Match') not in (None, '*', etag):
            with request_lock: requests.append({'status':412,'ifMatch':self.headers.get('If-Match'),'etag':etag})
            self.send_response(412); self.send_header('Content-Length','0'); self.send_header('Connection','close'); self.end_headers()
            return
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
        if self.headers.get('If-Range') not in (None, etag): match = None
        start = int(match[1]) if match else 0
        end = min(int(match[2]), len(payload)-1) if match and match[2] else len(payload)-1
        record={'time':time.time(),'monotonic':time.monotonic(),'path':self.path,'method':self.command,'range':self.headers.get('Range'),'start':start,'end':end,'etag':etag,'ifRange':self.headers.get('If-Range'),'ifMatch':self.headers.get('If-Match')}
        with request_lock: requests.append(record)
        comparing=bool(options.compare_host and self.path.startswith('/compare/'))
        if comparing and ('/latency-' in self.path or '/object-' in self.path): time.sleep(.15)
        self.send_response(206 if match else 200)
        self.send_header('Connection', 'close'); self.send_header('Content-Length', str(end-start+1)); self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Accept-Ranges', 'bytes'); self.send_header('ETag', etag)
        if match: self.send_header('Content-Range', f'bytes {start}-{end}/{len(payload)}')
        self.end_headers()
        if self.command=='HEAD': return
        inject_disconnect = False
        if options.compare_disconnect and comparing and match and start > 0 and end-start+1 > 262144 and self.command != 'HEAD':
            with request_lock:
                if self.path not in faulted_paths:
                    faulted_paths.add(self.path)
                    inject_disconnect = True
        chunk=65536 if comparing else 16384
        try:
            for offset in range(start,end+1,chunk):
                self.wfile.write(body[offset:min(offset+chunk,end+1)]); self.wfile.flush()
                record.setdefault('firstBodyMonotonic',time.monotonic())
                record['bodyBytesWritten'] = record.get('bodyBytesWritten', 0) + min(chunk, end-offset+1)
                record['lastBodyMonotonic'] = time.monotonic()
                if inject_disconnect and record['bodyBytesWritten'] >= 262144:
                    record['forcedDisconnectMonotonic'] = time.monotonic()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                time.sleep(.008 if comparing else .035)
        except (BrokenPipeError, ConnectionResetError): pass

def submit(url, port, method='GET', body=None, receipt_key=None, lose_ack=False):
    global last_submission
    # The original intake silently drops calls within 500 ms of its previous acceptance.
    # This isolated harness is the sole producer; serialize and require a new durable ID.
    receipt_key = receipt_key or str(uuid.uuid4())
    existing = receipts.begin(receipt_key,url,method,body,snapshot().get('records',[]))
    if existing is not None: return existing
    if options.desktop_session:
        nonce = str(uuid.uuid4())
        submission = {'key':receipt_key,'url':url,'method':method}
        if body is not None: submission['body'] = body.decode('utf8')
        temporary = ROOT/'submission.tmp'
        temporary.write_text(json.dumps({'nonce':nonce,'submission':submission}))
        temporary.replace(ROOT/'submission.json')
        def created():
            try:
                reply = json.loads((ROOT/'submission-result.json').read_text())
                if reply['nonce'] != nonce: return None
                assert reply['ok'], reply
                return str(reply['taskID'])
            except FileNotFoundError: return None
        task_id = wait(created,'desktop task creation',20)
        REPORT['desktopSubmissions'] = REPORT.get('desktopSubmissions',0) + 1
        submissions.append({'url':url,'taskID':task_id,'viaDesktopIntake':True})
        if lose_ack: raise LostAcknowledgement()
        return receipts.confirm(receipt_key,task_id)
    requested = time.monotonic()
    before = {str(row['id']) for row in snapshot().get('records', [])}
    remaining = .55 - (time.monotonic() - last_submission)
    if remaining > 0: time.sleep(remaining)
    sent = time.monotonic()
    with socket.create_connection(('127.0.0.1', port), timeout=5) as sock:
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(f'GET /download HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: neatextension.v1\r\n\r\n'.encode())
        response = b''
        while b'\r\n\r\n' not in response: response += sock.recv(4096)
        assert b' 101 ' in response.split(b'\r\n')[0]
        expected = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert expected in response
        message = f'1:{method}\r\n2:{url}\r\n6:normal\r\n'.encode()
        if body is not None: message += b'__0NeatPostData9__:' + body
        mask = os.urandom(4)
        header = bytes([0x81, 0x80|len(message)]) if len(message)<126 else bytes([0x81,0xfe])+struct.pack('!H',len(message))
        sock.sendall(header+mask+bytes(byte^mask[i%4] for i,byte in enumerate(message)))
        def accepted():
            added = [row for row in snapshot().get('records', []) if str(row['id']) not in before]
            assert len(added) <= 1, 'ambiguous acceptance: another producer added tasks'
            return added[0] if added else None
        row = wait(accepted, 'original intake acceptance', 10)
        # Snapshot time is later than actual acceptance: conservatively space from acknowledgement.
        last_submission = time.monotonic()
        submissions.append({'url':url,'taskID':row['id'],'queueSeconds':sent-requested,'ackSeconds':last_submission-sent})
        if lose_ack: raise LostAcknowledgement()
        return receipts.confirm(receipt_key,row['id'])

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
    subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','AppKit','-lsqlite3',str(pathlib.Path(__file__).with_name('probe.m')),'-o',str(library)], check=True, capture_output=True)
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
        if options.desktop_session:
            proc = subprocess.Popen(['node',str(options.desktop_session.resolve())], stdin=subprocess.PIPE, stdout=open(ROOT/'process.log','ab'), stderr=subprocess.STDOUT)
            proc.stdin.write(json.dumps({'directory':str(ROOT),'executable':arguments[0],'args':arguments[1:],'bridgePort':port}).encode())
            proc.stdin.close()
        else:
            proc = subprocess.Popen(arguments, stdout=open(ROOT/'process.log','ab'), stderr=subprocess.STDOUT)
        wait(lambda: engine_pid() and snapshot().get('pid') == engine_pid(), 'instrumented engine startup')
        assert pathlib.Path(snapshot()['support']).is_relative_to(PROFILE)
        assert pathlib.Path(snapshot()['output']) == OUTPUT
        print(json.dumps({'stage':'launched','pid':engine_pid(),'root':str(ROOT)}),flush=True)
    server = Server(('127.0.0.1',0), Handler)
    tls_context = None
    if options.tls_upstream or options.compare_untrusted_tls:
        config = ROOT/'certificate.cnf'
        config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
        certificate, private_key = ROOT/'fixture-cert.pem', ROOT/'fixture-key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(config),'-keyout',str(private_key),'-out',str(certificate)],check=True,capture_output=True)
        os.chmod(private_key,0o600)
        server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_tls.load_cert_chain(certificate,private_key)
        server.socket = server_tls.wrap_socket(server.socket,server_side=True)
        tls_context = ssl.create_default_context(cafile=str(certificate))
        REPORT['tlsFixture' if options.compare_untrusted_tls else 'tlsUpstream'] = {'verified':True,'trustScope':'fixture certificate in private Python SSLContext; system trust unchanged; neither engine receives custom trust'}
    threading.Thread(target=server.serve_forever,daemon=True).start()
    if options.tls_upstream:
        rejected = IdentityGuard(server.server_port,ROOT/'untrusted-pins.json',ssl.create_default_context())
        threading.Thread(target=rejected.serve_forever,daemon=True).start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1',rejected.server_port,timeout=10)
            connection.request('GET','/reuse.bin')
            response = connection.getresponse()
            assert response.status==502 and response.read()==b''
            connection.close()
            assert not (ROOT/'untrusted-pins.json').exists()
            REPORT['untrustedTLSRejected']=rejected.events
            assert rejected.events==[{'path':'/reuse.bin','blocked':True,'reason':'certificate-verification'}]
        finally:
            rejected.shutdown();rejected.server_close()
    target_port = server.server_port
    if options.identity_guard:
        guard = IdentityGuard(server.server_port, ROOT/'identity-pins.json',tls_context)
        threading.Thread(target=guard.serve_forever,daemon=True).start()
        target_port = guard.server_port
    if options.audit_original_socks or options.compare_socks:
        from original_socks import SocksFixture
        proxy_fixture = SocksFixture(server.server_port)
        arguments.extend(['-HTTP_IsActive', '1', '-HTTP_ProxyAddress', '127.0.0.1', '-HTTP_ProxyPort', str(proxy_fixture.port), '-HTTP_ProxyType', str(options.original_proxy_type), '-SocksVersion', '5'])
    launch()
    assert snapshot()['recordCount'] == 0
    if options.audit_original_socks:
        from original_socks import audit
        REPORT['originalSOCKS']=audit(proxy_fixture, submit, snapshot, port, server.server_port, requests, payload)
        REPORT['originalSOCKS']['proxyTypeSetting']=options.original_proxy_type
        REPORT['passed']=REPORT['originalSOCKS']['passed']
        assert REPORT['passed'], REPORT['originalSOCKS']
        raise ComparisonComplete()
    if options.compare_untrusted_tls:
        from compare_tls import compare_tls
        REPORT['directTLS']=compare_tls(options.compare_host, ROOT, submit, snapshot, server.server_port, port, requests, payload, free_port, tls_context, via_socks=options.tls_via_socks)
        REPORT['passed']=REPORT['directTLS']['passed']
        assert REPORT['passed'], REPORT['directTLS']
        raise ComparisonComplete()
    if options.compare_host:
        from compare_engines import compare
        REPORT['comparison']=compare(options.compare_host,ROOT,submit,snapshot,server.server_port,port,requests,payload,free_port, pause_verify=pause_and_verify if options.compare_pause else None, original_command=command, scenarios=['disconnect'] if options.compare_disconnect else ['redirect'] if options.compare_redirects else ['normal','latency'], socks_port=proxy_fixture.port if options.compare_socks else None)
        if options.compare_socks:
            REPORT['proxyRoutes']=proxy_fixture.routes
            assert proxy_fixture.routes and all(r.get('version') == 5 and not r.get('rejected') for r in proxy_fixture.routes)
        REPORT['passed']=True
        raise ComparisonComplete()
    submit(f'http://127.0.0.1:{target_port}/reuse.bin',port)
    task = wait(lambda:next((t for t in snapshot().get('tasks',[]) if t['working'] and t['percent']>2),None),'first progress')
    key = task['key']; REPORT['taskID'] = task['id']
    progress = task['engineProgress']
    assert progress['completedBytes'] > 0 and progress['bytesPerSecond'] >= 0
    assert sum(s['completed'] for s in progress['segments']) == progress['completedBytes']
    assert abs(progress['completedBytes']/len(payload)*100-task['percent']) < .00001
    REPORT['nativeProgress'] = task
    REPORT['pause'] = pause_and_verify(key)
    REPORT['resume'] = command('resume',key)
    wait(lambda:(t if (t:=current_task(key)) and t['working'] and t['percent']>8 else None),'resumed bytes')
    REPORT['beforeRestart'] = pause_and_verify(key)
    if options.headless:
        REPORT['headlessBeforeRestart'] = snapshot()
        assert snapshot()['visibleSamples'] == 0
    if options.identity_change:
        payload = os.urandom(len(payload))
        resource_version = 2
    if options.desktop_session:
        command('resume',key)
        wait(lambda: current_task(key) and current_task(key)['working'], 'active engine before managed stop')
        REPORT['managedStopWasActive'] = True
    first_pid = engine_pid()
    stop_engine()
    if options.desktop_session:
        settled_segments = segment_files(key)
        assert settled_segments and not current_task(key)['working']
        time.sleep(1)
        assert segment_files(key) == settled_segments
        REPORT['managedStopSegments'] = settled_segments
        REPORT['beforeRestart']['segments'] = settled_segments
    if options.restart_guard:
        old_pins = dict(guard.pins)
        old_port = guard.server_port
        old_events = list(guard.events)
        guard.shutdown();guard.server_close()
        guard = IdentityGuard(server.server_port,ROOT/'identity-pins.json',tls_context,listen_port=old_port)
        assert guard.pins == old_pins and old_pins
        threading.Thread(target=guard.serve_forever,daemon=True).start()
        REPORT['guardRestart']={'restoredPins':guard.pins,'samePort':guard.server_port==old_port,'priorEvents':old_events,'scope':'server instance recreated from disk; driver process remains alive'}
    launch()
    assert engine_pid() != first_pid
    assert snapshot()['recordCount'] == 1
    assert not snapshot()['tasks'], 'test requires restoring a persisted record, not retaining an old engine object'
    assert segment_files(key) == REPORT['beforeRestart']['segments']
    REPORT['restore'] = command('resume',key)
    assert REPORT['restore'].get('loadedFromRecord') is True
    if options.identity_guard and options.identity_change:
        wait(lambda:any(str(r['id'])==key and str(r['status']).startswith('Error') for r in snapshot()['records']),'identity conflict error')
        assert not (OUTPUT/'reuse.bin').exists()
        assert segment_files(key)==REPORT['beforeRestart']['segments'], 'identity conflict modified saved segments'
        REPORT.update({'passed':True,'identityConflictBlocked':True,'segmentsUnchanged':True,'finalState':snapshot(),'guardEvents':guard.events,'requests':requests,'pins':json.loads((ROOT/'identity-pins.json').read_text())})
        raise GuardAuditComplete()
    wait(lambda:any(t['key']==key and t['working'] for t in snapshot()['tasks']),'restored engine')
    # Original creates the final path while merging; wait for its durable Complete state.
    wait(lambda:any(str(row['id'])==key and row['status']=='Complete' for row in snapshot().get('records',[])),'completed state',120)
    final = OUTPUT/'reuse.bin'
    assert final.stat().st_size == len(payload)
    if options.identity_change:
        data = final.read_bytes()
        old_only = sum(a == b and a != c for a,b,c in zip(data,original_payload,payload))
        new_only = sum(a == c and a != b for a,b,c in zip(data,original_payload,payload))
        unknown = sum(a != b and a != c for a,b,c in zip(data,original_payload,payload))
        REPORT['identityAudit'] = {'oldSHA256':sha(original_payload),'newSHA256':sha(payload),'actualSHA256':sha(data),'oldOnlyBytes':old_only,'newOnlyBytes':new_only,'neitherVersionBytes':unknown,'mixed':old_only>0 and new_only>0,'completeRecord':snapshot()['records']}
        REPORT['requests']=requests
        assert sha(data)==sha(payload), 'Original engine reported Complete with a stale or mixed resource'
    assert sha(final.read_bytes()) == sha(payload)
    if options.headless:
        completed = snapshot()
        assert completed['headless'] and completed['visibleSamples'] == 0 and completed['presentationRequests'] > 0, completed
        REPORT['headlessCompletion'] = completed
        submit(f'http://127.0.0.1:{target_port}/missing.bin',port)
        wait(lambda: any(r.get('status') == 404 for r in requests), '404 request')
        wait(lambda: any(str(r['id']) != key and str(r['status']).startswith('Error') for r in snapshot().get('records', [])), '404 error record')
        time.sleep(1)
        failure = snapshot()
        assert time.time() - failure['time'] < 2, 'hidden error blocked snapshot delivery'
        assert failure['visibleSamples'] == 0, failure
        REPORT['http404Observation'] = failure
        submit(f'http://127.0.0.1:{target_port}/auth.bin',port)
        auth = wait(lambda: next((t for t in snapshot().get('tasks',[]) if t.get('authenticating') is True), None), 'authentication required')
        REPORT['authenticationRequired'] = snapshot()
        REPORT['pauseDuringAuthentication'] = command('pause',auth['key'],expected_ok=False)
        assert REPORT['pauseDuringAuthentication']['error']=='interaction-required'
        assert current_task(auth['key'])['authenticating']
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
        submit(f'http://127.0.0.1:{target_port}/auth-a.bin',port)
        a = wait(lambda: next((t for t in snapshot()['tasks'] if t['authenticating']),None),'first concurrent challenge')['key']
        submit(f'http://127.0.0.1:{target_port}/auth-b.bin',port)
        b = wait(lambda: next((t for t in snapshot()['tasks'] if t['authenticating'] and t['key']!=a),None),'second concurrent challenge')['key']
        assert snapshot()['pendingAuthSheets'] == 2
        REPORT['concurrentAuthentication'] = snapshot()
        REPORT['wrongCredentialReply'] = command('submit-auth',a,username='fixture',password='wrong-synthetic-password')
        wait(lambda: snapshot()['completedAuthSheets']==2 and snapshot()['pendingAuthSheets']==2, 'wrong password rechallenge')
        assert current_task(b)['authenticating']
        REPORT['wrongCredentialRechallenge'] = snapshot()
        REPORT['concurrentCancel'] = command('cancel-auth',b)
        wait(lambda: snapshot()['pendingAuthSheets']==1, 'second challenge removed')
        assert current_task(a)['authenticating']
        REPORT['credentialReply'] = command('submit-auth',a,username='fixture',password='synthetic-password')
        wait(lambda:any(str(r['id'])==a and r['status']=='Complete' for r in snapshot()['records']),'authenticated completion',120)
        assert sha((OUTPUT/'auth-a.bin').read_bytes())==sha(payload)
        assert any(str(r['id'])==b and str(r['status']).startswith('Error') for r in snapshot()['records'])
        assert not (OUTPUT/'auth-b.bin').exists()
        assert snapshot()['pendingAuthSheets']==0 and snapshot()['completedAuthSheets']==4
        assert snapshot()['visibleSamples']==0
        REPORT['authenticatedSHA256']=sha((OUTPUT/'auth-a.bin').read_bytes())
        REPORT['authenticationFinalState']=snapshot()
        burst = [submit(f'http://127.0.0.1:{target_port}/missing-burst-{i}.bin',port) for i in range(6)]
        assert len(set(burst))==6
        wait(lambda: all(any(str(r['id'])==key and str(r['status']).startswith('Error') for r in snapshot()['records']) for key in burst),'burst task outcomes')
        REPORT['burstTaskIDs']=burst
        REPORT['submissions']=submissions
        receipt_key = 'lost-ack-fixture'
        count_before = snapshot()['recordCount']
        try:
            submit(f'http://127.0.0.1:{target_port}/missing-receipt.bin',port,receipt_key=receipt_key,lose_ack=True)
            raise AssertionError('Expected simulated lost acknowledgement')
        except LostAcknowledgement: pass
        # Recover in a fresh Python process from only saved journal and engine snapshot.
        recovered = subprocess.check_output(['python3','-c',
            'import pathlib,sys;from receipts import Receipts,read_records;print(Receipts(pathlib.Path(sys.argv[1])).recover(sys.argv[2],read_records(pathlib.Path(sys.argv[3]))))',
            str(ROOT/'submission-receipts.json'),receipt_key,str(pathlib.Path(snapshot()['support'])/'NeatDB.db')],cwd=pathlib.Path(__file__).parent,text=True).strip()
        receipts = Receipts(ROOT/'submission-receipts.json')
        replay = submit(f'http://127.0.0.1:{target_port}/missing-receipt.bin',port,receipt_key=receipt_key)
        assert replay == recovered and snapshot()['recordCount']==count_before+1
        REPORT['receiptRecovery']={'taskID':recovered,'sameIDOnReplay':replay==recovered,'createdCount':snapshot()['recordCount']-count_before,'freshRecoveryProcess':True}

    if options.post_audit:
        post_key = submit(f'http://127.0.0.1:{target_port}/post.bin',port,method='POST',body=post_body)
        wait(lambda:any(str(r['id'])==post_key and r['status']=='Complete' for r in snapshot()['records']),'POST completed',120)
        post_requests = [r for r in requests if r.get('path')=='/post.bin']
        assert post_requests and all(r.get('method')=='POST' and r.get('validBody') for r in post_requests), post_requests
        assert sha((OUTPUT/'post.bin').read_bytes())==sha(payload)
        REPORT['postAudit']={'taskID':post_key,'requests':post_requests,'outputSHA256':sha((OUTPUT/'post.bin').read_bytes()),'expectedBodySHA256':sha(post_body)}
    if guard: REPORT['guardEvents']=guard.events
    mapped = desktop_snapshot()
    if mapped:
        row = next(t for t in mapped['tasks'] if str(t['id']) == key)
        assert row['status'] == 'complete' and row['completedBytes'] == len(payload), row
    REPORT.update({'passed':True,'sha256':sha(payload),'bytes':len(payload),'requests':requests,'finalState':snapshot(),'originalTextUnchanged':True})
    print(json.dumps({'stage':'passed','root':str(ROOT),'bytes':len(payload)}),flush=True)
except ComparisonComplete:
    print('Original SOCKS audit passed' if options.audit_original_socks else 'Original/current engine comparison passed',flush=True)
except GuardAuditComplete:
    print("Identity conflict blocked; original segments preserved",flush=True)
except BaseException as error:
    REPORT['error'] = repr(error)
    raise
finally:
    cleanup_error = None
    if proc and proc.poll() is None:
        try: stop_engine()
        except BaseException as error:
            cleanup_error = error
            REPORT['cleanupError'] = repr(error)
            REPORT['passed'] = False
    if proxy_fixture: proxy_fixture.close()
    if guard: guard.shutdown();guard.server_close()
    if server: server.shutdown();server.server_close()
    REPORT['sourceUnchanged'] = sha((SOURCE/'Contents/MacOS/NeatDownloadManager').read_bytes()) == REPORT.get('sourceSHA256')
    REPORT['processStopped'] = proc is None or proc.poll() is not None
    # Only this freshly created, known test copy is moved to Trash; evidence stays in ROOT.
    try:
        if APP.exists() and REPORT['processStopped']: subprocess.run(['/usr/bin/trash',str(APP)],check=True)
        REPORT['copyTrashed'] = not APP.exists()
    finally:
        (ROOT/'report.json').write_text(json.dumps(REPORT,indent=2))
    print('Report:',ROOT/'report.json',flush=True)

    if cleanup_error: raise cleanup_error
