"""Research-only loopback HTTP response guard; not a general proxy or HTTPS backend."""
import http.client
import http.server
import json
import threading

class IdentityGuard(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, upstream_port, state_path):
        self.upstream_port = upstream_port
        self.state_path = state_path
        self.lock = threading.Lock()
        self.pins = json.loads(state_path.read_text()) if state_path.exists() else {}
        self.events = []
        super().__init__(('127.0.0.1', 0), Handler)

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass
    def do_GET(self):
        # One fixed local origin; never accept an arbitrary proxy destination.
        if not self.path.startswith('/') or self.path.startswith('//'):
            self.send_error(400); return
        upstream = http.client.HTTPConnection('127.0.0.1', self.server.upstream_port, timeout=10)
        try:
            headers = {name:self.headers[name] for name in ('Range','Authorization') if name in self.headers}
            upstream.request('GET', self.path, headers=headers)
            response = upstream.getresponse()
            if response.status in (200, 206):
                etag = response.getheader('ETag')
                with self.server.lock:
                    expected = self.server.pins.get(self.path)
                    valid = isinstance(etag,str) and len(etag)>=2 and etag.startswith('"') and etag.endswith('"')
                    conflict = not valid or (expected is not None and expected != etag)
                    if not conflict and expected is None:
                        updated = dict(self.server.pins, **{self.path:etag})
                        temporary = self.server.state_path.with_suffix('.tmp')
                        temporary.write_text(json.dumps(updated)); temporary.replace(self.server.state_path)
                        self.server.pins = updated
                    self.server.events.append({'path':self.path,'etag':etag,'expected':expected,'blocked':conflict})
                if conflict:
                    # No upstream body has been read or forwarded at this point.
                    self.send_response(412); self.send_header('Content-Length','0')
                    self.send_header('Connection','close'); self.end_headers(); return
            self.send_response(response.status)
            for name in ('Content-Length','Content-Type','Content-Range','ETag','Accept-Ranges','WWW-Authenticate'):
                value = response.getheader(name)
                if value is not None: self.send_header(name,value)
            self.send_header('Connection','close'); self.end_headers()
            while chunk := response.read(16384):
                self.wfile.write(chunk); self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):
            pass
        finally:
            upstream.close()
