"""Release Host HLS redirects/SOCKS regression; only isolated synthetic tasks."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time

from original_socks import SocksFixture


def unused_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    root = Path(tempfile.mkdtemp(prefix='ndm-hls-proxy-'))
    events = []
    repository = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', type=Path, default=repository / 'native/.build/release/NDMHost')
    parser.add_argument('--tools', type=Path, default=repository / 'native/Vendor/Tools')
    options = parser.parse_args()
    tools = options.tools.resolve(strict=True)
    ffmpeg = tools / 'ffmpeg'
    # A real fMP4 fixture also exercises remuxing and decoded-frame integrity.
    subprocess.run([str(ffmpeg), '-v', 'error', '-f', 'lavfi', '-i',
                    'testsrc2=size=64x64:rate=10:duration=1', '-c:v', 'mpeg4',
                    '-g', '10', '-f', 'hls', '-hls_segment_type', 'fmp4',
                    '-hls_time', '1', '-hls_list_size', '0', 'fixture.m3u8'],
                   cwd=root, check=True, timeout=30)
    initialization = (root / 'init.mp4').read_bytes()
    payload = (root / 'fixture0.m4s').read_bytes()
    merged = root / 'reference-fragments.mp4'
    merged.write_bytes(initialization + payload)
    reference = root / 'reference.mp4'
    subprocess.run([str(ffmpeg), '-v', 'error', '-y', '-i', str(merged),
                    '-c', 'copy', '-movflags', '+faststart', str(reference)], check=True, timeout=30)
    expected = reference.read_bytes()

    def decoded_frames(path):
        result = subprocess.run([str(ffmpeg), '-v', 'error', '-i', str(path),
                                 '-f', 'framemd5', '-'], check=True, capture_output=True, timeout=30)
        return [line for line in result.stdout.decode().splitlines() if line and not line.startswith('#')]

    expected_frames = decoded_frames(reference)
    assert len(expected_frames) == 10

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            events.append({'method': self.command, 'path': self.path})
            case = self.path.split('/')[1]
            redirects = {f'/{case}/entry.m3u8': f'/{case}/master/index.m3u8',
                         f'/{case}/master/video.m3u8': f'/{case}/media/index.m3u8'}
            if self.path in redirects:
                self.send_response(302)
                self.send_header('Location', redirects[self.path])
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            files = {
                f'/{case}/master/index.m3u8': b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8\n',
                f'/{case}/media/index.m3u8': b'#EXTM3U\n#EXT-X-MAP:URI="init.bin"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n',
                f'/{case}/media/init.bin': initialization,
                f'/{case}/media/segment.ts': payload,
            }
            data = files.get(self.path)
            self.send_response(200 if data is not None else 404)
            self.send_header('Content-Length', str(len(data or b'')))
            self.send_header('Content-Type', 'application/vnd.apple.mpegurl' if self.path.endswith('.m3u8') else 'application/octet-stream')
            self.end_headers()
            if self.command != 'HEAD' and data is not None:
                self.wfile.write(data)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    proxy = SocksFixture(server.server_port)
    host_port, bridge_port = unused_port(), unused_port()
    home, output = root / 'home', root / 'downloads'
    home.mkdir(); output.mkdir()
    env = dict(PATH='/usr/bin:/bin', HOME=str(home), CFFIXED_USER_HOME=str(home),
               NDM_SUPPORT_DIR=str(root / 'support'), NDM_HOST_PORT=str(host_port),
               NDM_BRIDGE_PORT=str(bridge_port), NDM_DISABLE_LEGACY_BRIDGE='1', NDM_TOOL_DIR=str(tools))
    host_path = options.host.resolve(strict=True)
    report = {'root': str(root), 'hostSHA256': hashlib.sha256(host_path.read_bytes()).hexdigest(),
              'expectedSHA256': hashlib.sha256(expected).hexdigest(), 'cases': []}

    def rpc(op, **kwargs):
        with socket.create_connection(('127.0.0.1', host_port), timeout=5) as client:
            client.sendall((json.dumps(dict(id=1, op=op, **kwargs)) + '\n').encode())
            for line in client.makefile('r'):
                response = json.loads(line)
                if response.get('id') == 1:
                    assert response.get('ok'), response
                    return response
            raise RuntimeError('Host closed before replying')

    with (root / 'host.log').open('w') as log:
        host = subprocess.Popen([str(host_path)], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                try:
                    rpc('ping')
                    break
                except OSError:
                    time.sleep(.1)
            for kind in ['direct', 'socks', 'rejected']:
                proxy.reject = kind == 'rejected'
                route_start = len(proxy.routes)
                rpc('updateSettings', httpProxyEnabled=False, socksProxyEnabled=kind != 'direct',
                    socksProxyHost='127.0.0.1', socksProxyPort=proxy.port)
                task_id = rpc('add', url=f'http://127.0.0.1:{server.server_port}/{kind}/entry.m3u8',
                              folderPath=str(output), ltype='hls')['task']['id']
                for _ in range(200):
                    task = next(t for t in rpc('list')['tasks'] if t['id'] == task_id)
                    if task['status'] in ['complete', 'error']:
                        break
                    time.sleep(.1)
                case = {'kind': kind, 'status': task['status'],
                        'originRequests': [e for e in events if e['path'].startswith(f'/{kind}/')],
                        'proxyRoutes': proxy.routes[route_start:]}
                report['cases'].append(case)
                if kind == 'rejected':
                    assert task['status'] == 'error' and not case['originRequests'], case
                    assert case['proxyRoutes'] and all(r['rejected'] for r in case['proxyRoutes']), case
                else:
                    assert task['status'] == 'complete', case
                    result_path = Path(task['folderPath']) / task['filename']
                    result = result_path.read_bytes()
                    assert result == expected
                    assert decoded_frames(result_path) == expected_frames
                    case['verifiedFrames'] = len(expected_frames)
                    case['outputSHA256'] = hashlib.sha256(result).hexdigest()
                    case['outputBytes'] = len(result)
                    assert any(e['path'] == f'/{kind}/media/init.bin' for e in case['originRequests'])
                    assert bool(case['proxyRoutes']) == (kind == 'socks')
            report['passed'] = True
        finally:
            if host.poll() is None:
                host.terminate()
                host.wait(timeout=15)
            server.shutdown(); server.server_close(); proxy.close()
            report['hostStopped'] = host.poll() is not None
            (root / 'report.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
