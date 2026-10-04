"""Isolated release Host regression: unavailable proxy must not bypass to loopback.

Only owns synthetic tasks, local servers, a temporary profile and one child Host.
"""
import socket,subprocess,tempfile,pathlib,json,time,threading,http.server,os
root=pathlib.Path(tempfile.mkdtemp(prefix='ndm-proxy-routing-')); events=[]
class H(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_HEAD(self):self.do_GET()
 def do_GET(self):
  events.append({'method':self.command,'path':self.path,'range':self.headers.get('Range')})
  payload=b'proxy-routing-fixture'*512
  self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.send_header('Content-Type','application/octet-stream');self.end_headers()
  if self.command!='HEAD':self.wfile.write(payload)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=server.serve_forever,daemon=True).start()
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
p,b=port(),port();home=root/'home';home.mkdir();output=root/'downloads';output.mkdir()
env=dict(PATH='/usr/bin:/bin',HOME=str(home),CFFIXED_USER_HOME=str(home),NDM_SUPPORT_DIR=str(root/'support'),NDM_HOST_PORT=str(p),NDM_BRIDGE_PORT=str(b),NDM_DISABLE_LEGACY_BRIDGE='1')
def rpc(op,**kw):
 with socket.create_connection(('127.0.0.1',p),timeout=5) as c:
  c.sendall((json.dumps(dict(id=1,op=op,**kw))+'\n').encode())
  for l in c.makefile('r'):
   r=json.loads(l)
   if r.get('id')==1:
    assert r.get('ok'),r
    return r
h=subprocess.Popen([str(pathlib.Path(__file__).resolve().parents[3]/'native/.build/release/NDMHost')],env=env,stdout=(root/'host.log').open('w'),stderr=subprocess.STDOUT)
report={'root':str(root),'cases':[]}
try:
 for _ in range(100):
  try:rpc('ping');break
  except OSError:time.sleep(.1)
 for kind in ['direct','http','socks']:
  rpc('updateSettings',httpProxyEnabled=kind=='http',httpProxyHost='127.0.0.1',httpProxyPort=1,socksProxyEnabled=kind=='socks',socksProxyHost='127.0.0.1',socksProxyPort=1)
  key=rpc('add',url=f'http://127.0.0.1:{server.server_port}/{kind}.bin',folderPath=str(output))['task']['id']
  for _ in range(100):
   task=next(t for t in rpc('list')['tasks'] if t['id']==key)
   if task['status'] in ['complete','error']:break
   time.sleep(.1)
  report['cases'].append({'kind':kind,'status':task['status'],'completedBytes':task['completedBytes'],'originRequests':[e for e in events if e['path']==f'/{kind}.bin']})
finally:
 try:
  if h.poll() is None: rpc('pauseAll')
 finally:
  if h.poll() is None: h.terminate();h.wait(timeout=15)
  server.shutdown();server.server_close()
 report['hostStopped']=h.poll() is not None
 (root/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))

assert report['hostStopped']
assert report['cases'][0]['status']=='complete' and report['cases'][0]['originRequests']
for case in report['cases'][1:]:
 assert case['status']=='error' and case['completedBytes']==0 and not case['originRequests'], case
