"""Compare URLSession SOCKS routing APIs without changing system proxy settings."""
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
from original_socks import SocksFixture

root = Path(tempfile.mkdtemp(prefix='ndm-proxy-api-'))
binary = root / 'probe'
subprocess.run(['swiftc', str(Path(__file__).with_name('proxy-api-probe.swift')),
                '-o', str(binary)], check=True)
requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        requests.append(self.path)
        self.send_response(200)
        self.send_header('Content-Length', '3')
        self.end_headers()
        self.wfile.write(b'abc')


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
proxy = SocksFixture(server.server_port)
report = {'passed': False, 'root': str(root), 'cases': [],
          'scope': 'URLSession API behavior on this macOS host, not product or other OS acceptance',
          'osVersion': subprocess.check_output(['sw_vers', '-productVersion'], text=True).strip()}
try:
    for mode in ['dictionary', 'dictionary-explicit', 'modern']:
        for host in ['127.0.0.1', 'api-proxy.ndm.invalid']:
            for reject in [False, True]:
                proxy.reject = reject
                before = len(proxy.routes)
                path = f'/{mode}-{host}-{reject}'
                result = subprocess.run([str(binary), mode, str(proxy.port),
                                         f'http://{host}:{server.server_port}{path}'],
                                        capture_output=True, text=True, timeout=15)
                case = {'mode': mode, 'host': host, 'reject': reject,
                        'exitCode': result.returncode, 'client': json.loads(result.stdout),
                        'routes': proxy.routes[before:], 'originReached': path in requests}
                report['cases'].append(case)
                assert result.returncode == 0 and not case['client'].get('timeout'), case
                if host.endswith('.invalid'):
                    assert case['routes'], 'Configuration must demonstrably use SOCKS for remote names'
                    assert case['originReached'] is not reject
                    assert case['client']['bytes'] == (0 if reject else 3)
                else:
                    # Regression evidence for the observed system limitation,
                    # not a desired product behavior. A changed OS should fail
                    # this assertion and trigger reassessment of the workaround.
                    assert case['originReached'] and not case['routes'] and case['client']['bytes'] == 3, case
                print(json.dumps(case), flush=True)
    report['passed'] = True
finally:
    proxy.close()
    server.shutdown()
    server.server_close()
    (root / 'report.json').write_text(json.dumps(report, indent=2))
    print('Report:', root / 'report.json', flush=True)
