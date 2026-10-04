"""SOCKS5 fixture: loopback by default; optional explicitly pinned upstream."""
import hashlib
import select
import socket
import socketserver
import threading
import time
from pathlib import Path


class SocksFixture:
    def __init__(self, origin_port, *, pinned_host=None):
        self.routes = []
        self.reject = False
        owner = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                client = self.request
                client.settimeout(5)

                def read(count):
                    data = b''
                    while len(data) < count:
                        chunk = client.recv(count - len(data))
                        if not chunk:
                            raise EOFError()
                        data += chunk
                    return data

                try:
                    version, count = read(2)
                    if version == 4:
                        assert count == 1
                        port = int.from_bytes(read(2), 'big')
                        address = read(4)

                        def terminated():
                            value = b''
                            while len(value) < 1024:
                                byte = read(1)
                                if byte == b'\x00':
                                    return value
                                value += byte
                            raise ValueError('Unbounded SOCKS4 field')

                        terminated()  # Synthetic user ID, deliberately not logged.
                        host = terminated().decode('ascii') if address[:3] == bytes(3) and address[3] else socket.inet_ntop(socket.AF_INET, address)
                        owner.routes.append({'version': 4, 'host': host, 'port': port, 'rejected': True})
                        # This fixture supports SOCKS5 success only. Record and
                        # explicitly reject the original's SOCKS4 fallback.
                        client.sendall(b'\x00\x5b' + bytes(6))
                        return
                    if version != 5:
                        owner.routes.append({'unexpectedProtocolPrefix': [version, count]})
                        return
                    assert 0 in read(count)
                    client.sendall(b'\x05\x00')
                    version, command, reserved, kind = read(4)
                    assert version == 5 and command == 1 and reserved == 0
                    if kind == 1:
                        host = socket.inet_ntop(socket.AF_INET, read(4))
                    elif kind == 4:
                        host = socket.inet_ntop(socket.AF_INET6, read(16))
                    else:
                        assert kind == 3
                        host = read(read(1)[0]).decode('ascii')
                    port = int.from_bytes(read(2), 'big')
                    route = {'version': 5, 'host': host, 'port': port, 'rejected': owner.reject,
                             'bytesToOrigin': 0, 'bytesFromOrigin': 0}
                    owner.routes.append(route)
                    if owner.reject or port != origin_port or (pinned_host and host != pinned_host):
                        route['rejected'] = True
                        client.sendall(b'\x05\x05\x00\x01' + bytes(6))
                        return
                    with socket.create_connection((pinned_host or '127.0.0.1', origin_port), timeout=5) as upstream:
                        client.sendall(b'\x05\x00\x00\x01' + bytes(6))
                        while True:
                            ready, _, _ = select.select([client, upstream], [], [], 5)
                            if not ready:
                                return
                            for source in ready:
                                data = source.recv(65536)
                                if not data:
                                    return
                                (upstream if source is client else client).sendall(data)
                                route['bytesToOrigin' if source is client else 'bytesFromOrigin'] += len(data)
                except (OSError, EOFError, ValueError):
                    pass

        class Server(socketserver.ThreadingTCPServer):
            daemon_threads = True
        self.server = Server(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def audit(proxy, submit, snapshot, bridge_port, origin_port, requests, payload):
    report = {'scope': 'Original macOS 1.3 SOCKS routing; synthetic loopback-only transport', 'cases': []}
    for name, host, reject in [('loopback', '127.0.0.1', False),
                               ('remote-name', 'socks-fixture.ndm.invalid', False),
                               ('rejected-loopback', '127.0.0.1', True)]:
        proxy.reject = reject
        first = len(proxy.routes)
        path = f'/socks-{name}.bin'
        key = str(submit(f'http://{host}:{origin_port}{path}', bridge_port))
        deadline = time.monotonic() + 20
        terminal = False
        while time.monotonic() < deadline:
            row = next((r for r in snapshot().get('records', []) if str(r['id']) == key), {})
            status = str(row.get('status', ''))
            if status == 'Complete' or status.startswith('Error'):
                terminal = True
                break
            time.sleep(.1)
        case = {'name': name, 'terminal': terminal, 'task': row,
                'proxyRoutes': proxy.routes[first:],
                'originRequests': [r for r in requests if r.get('path') == path]}
        if status == 'Complete':
            output = Path(row['folderpath']) / row['filename']
            case['outputSHA256'] = hashlib.sha256(output.read_bytes()).hexdigest()
            assert case['outputSHA256'] == hashlib.sha256(payload).hexdigest()
        report['cases'].append(case)
        if not terminal:
            break  # Do not attribute a previous task's retries to the next case.
    report['verifiedSOCKS5Handshake'] = any(r.get('version') == 5 for r in proxy.routes)
    cases = report['cases']
    report['passed'] = len(cases) == 3 and all(c['terminal'] for c in cases)
    if report['passed']:
        report['passed'] = all(c['task']['status'] == 'Complete' and c['proxyRoutes'] and
                              all(r.get('version') == 5 and not r['rejected'] and r['bytesToOrigin'] > 0 and r['bytesFromOrigin'] > 0 for r in c['proxyRoutes'])
                              for c in cases[:2])
        report['passed'] = report['passed'] and cases[2]['task']['status'].startswith('Error') and not cases[2]['originRequests'] and bool(cases[2]['proxyRoutes'])
        report['passed'] = report['passed'] and all(r.get('rejected') for r in cases[2]['proxyRoutes'])
    return report
