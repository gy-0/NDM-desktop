"""Observe Network.framework proxy routing with only local synthetic traffic."""
import http.server
import json
import pathlib
import platform
import subprocess
import tempfile
import threading
from original_socks import SocksFixture

assert platform.system() == 'Darwin', 'macOS research probe only'
root = pathlib.Path(tempfile.mkdtemp(prefix='ndm-nw-proxy-routing-'))
source = pathlib.Path(__file__).with_name('probe_nw_proxy.swift')
subprocess.run(['xcrun', 'swiftc', '-target', platform.machine() + '-apple-macos14.0',
                str(source), '-o', str(root / 'probe')], check=True)
hits = []


class Origin(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        hits.append(self.path)
        self.send_response(200)
        self.send_header('Content-Length', '3')
        self.end_headers()
        self.wfile.write(b'abc')


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Origin)
threading.Thread(target=server.serve_forever, daemon=True).start()
proxy = SocksFixture(server.server_port)
report = {'observed': False, 'root': str(root),
          'scope': 'Raw NWConnection TCP with per-connection PrivacyContext; not URLSession, TLS or production acceptance',
          'os': subprocess.check_output(['sw_vers'], text=True), 'cases': []}
try:
    for host in ('127.0.0.1', 'fixture.ndm.invalid'):
        for reject in (False, True):
            proxy.reject = reject
            before_routes, before_hits = len(proxy.routes), len(hits)
            result = subprocess.run([str(root / 'probe'), str(proxy.port),
                                     str(server.server_port), host], capture_output=True, text=True, timeout=12)
            case = {'host': host, 'reject': reject, 'exit': result.returncode,
                    'client': result.stdout, 'stderr': result.stderr,
                    'routes': [dict(r) for r in proxy.routes[before_routes:]],
                    'originRequests': len(hits) - before_hits}
            report['cases'].append(case)
            assert result.returncode == 0, case
            if host == '127.0.0.1':
                assert not case['routes'] and case['originRequests'] == 1, case
            else:
                assert case['routes'], 'Positive control must actually configure a SOCKS route'
                assert all(r['host'] == host and r['rejected'] == reject for r in case['routes']), case
                assert case['originRequests'] == (0 if reject else 1), case
    report['observed'] = True
finally:
    proxy.close()
    server.shutdown()
    server.server_close()
    (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
