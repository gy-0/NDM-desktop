"""Research-only loopback HTTP response guard; not a general-purpose proxy."""
import http.client
import http.server
import json
import os
import threading
import ssl

class IdentityGuard(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, upstream_port, state_path, tls_context=None, listen_port=0):
        if tls_context is not None and (not tls_context.check_hostname or tls_context.verify_mode != ssl.CERT_REQUIRED):
            raise ValueError("Verified TLS with hostname checking is required")
        self.tls_context = tls_context
        self.upstream_port = upstream_port
        self.state_path = state_path
        self.lock = threading.Lock()
        self.origin = f'{"https" if tls_context else "http"}://127.0.0.1:{upstream_port}'
        self.pins = {}
        if state_path.exists():
            stored = json.loads(state_path.read_text())
            if not isinstance(stored,dict) or stored.get('version')!=1 or stored.get('origin')!=self.origin:
                raise ValueError('Identity store does not belong to this origin/version')
            pins = stored.get('pins')
            if not isinstance(pins,dict) or not all(isinstance(k,str) and k.startswith('/') and isinstance(v,str) and len(v)>=2 and v.startswith('"') and v.endswith('"') for k,v in pins.items()):
                raise ValueError('Invalid identity pins; refusing to reset them')
            self.pins = pins
        self.events = []
        super().__init__(('127.0.0.1', listen_port), Handler)

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass
    def do_GET(self):
        # One fixed local origin; never accept an arbitrary proxy destination.
        if not self.path.startswith('/') or self.path.startswith('//'):
            self.send_error(400); return
        upstream = (http.client.HTTPSConnection('127.0.0.1', self.server.upstream_port, timeout=10, context=self.server.tls_context)
                    if self.server.tls_context else http.client.HTTPConnection('127.0.0.1', self.server.upstream_port, timeout=10))
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
                        with temporary.open('w') as stream:
                            json.dump({'version':1,'origin':self.server.origin,'pins':updated},stream)
                            stream.flush();os.fsync(stream.fileno())
                        temporary.replace(self.server.state_path)
                        directory=os.open(self.server.state_path.parent,os.O_RDONLY)
                        try: os.fsync(directory)
                        finally: os.close(directory)
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
        except ssl.SSLCertVerificationError:
            with self.server.lock:
                self.server.events.append({'path':self.path,'blocked':True,'reason':'certificate-verification'})
            self.send_response(502); self.send_header('Content-Length','0')
            self.send_header('Connection','close'); self.end_headers()
        except (BrokenPipeError,ConnectionResetError):
            pass
        finally:
            upstream.close()
