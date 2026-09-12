import http.server,threading,time,json,re,hashlib
from pathlib import Path
root=Path('/tmp/neat-runtime-audit'); log=root/'http-events.jsonl'; lock=threading.Lock(); active={}; ids=0
SIZE=128*1024*1024; CHUNK=bytes(range(256))*256
class Server(http.server.ThreadingHTTPServer):daemon_threads=True
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*a):pass
 def do_HEAD(self):self.serve(True)
 def do_GET(self):self.serve(False)
 def serve(self,head):
  global ids
  name=self.path.split('?')[0];case=name.strip('/').split('/')[0]
  if name.endswith('.m3u8'):
   payload=('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n'+''.join('#EXTINF:2,\nhttp://127.0.0.1:42080/%s/%03d.ts\n'%(case,i) for i in range(96))+'#EXT-X-ENDLIST\n').encode(); size=len(payload)
  elif name.endswith('.ts'):
   payload=(root/'fixture.ts').read_bytes()
   if case=='hls-unique':payload+=bytes([0x47,0x1f,0xff,0x10])+int(name.rsplit('/',1)[1][:-3]).to_bytes(8,'big')+bytes([0xff])*176
   size=len(payload)
  else:payload=None;size=SIZE
  rangeText=self.headers.get('Range','');m=re.fullmatch(r'bytes=(\d+)-(\d*)',rangeText)
  start=int(m[1]) if m else 0;end=min(int(m[2]),size-1) if m and m[2] else size-1
  with lock:
   ids+=1;rid=ids;active[case]=active.get(case,0)+(not head); concurrency=active[case]
  code=429 if case=='limited' and concurrency>4 else (206 if m else 200)
  if start>=size or end<start:code=416
  def event(kind,**kw):
   with lock:
    with log.open('a') as f:f.write(json.dumps(dict(t=time.monotonic(),event=kind,id=rid,case=case,path=name,range=rangeText,start=start,end=end,method=self.command,code=code,**kw))+'\n')
  event('start',active=concurrency)
  sent=0
  try:
   self.send_response(code);self.send_header('Accept-Ranges','bytes');self.send_header('ETag','"reference-fixture-v1"');self.send_header('Content-Type','application/vnd.apple.mpegurl' if name.endswith('.m3u8') else 'video/mp2t' if name.endswith('.ts') else 'application/octet-stream')
   if code in (429,416):
    self.send_header('Content-Length','0');self.send_header('Retry-After','1');self.end_headers();return
   if m:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
   self.send_header('Content-Length',str(end-start+1));self.end_headers()
   if head:return
   delay=1.0 if case=='pause' else .2 if case=='slow' and rid%7==0 else .035
   for pos in range(start,end+1,len(CHUNK)):
    n=min(len(CHUNK),end-pos+1)
    data=payload[pos:pos+n] if payload else (CHUNK[pos%256:]+CHUNK[:pos%256])[:n]
    self.wfile.write(data);self.wfile.flush();sent+=len(data);time.sleep(delay)
  except (BrokenPipeError,ConnectionResetError,TimeoutError):event('disconnect',sent=sent)
  finally:
   with lock:active[case]-=(not head)
   event('end',sent=sent)
(root/'server.json').write_text(json.dumps({'size':SIZE,'port':42080,'data':'byte at file offset = offset modulo 256'}))
Server(('127.0.0.1',42080),Handler).serve_forever()
