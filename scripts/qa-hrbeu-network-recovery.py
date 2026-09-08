# Real-site regression for the public HRBEU MP4; not a deterministic CI test.
# Uses a separate Host/profile and only removes data created by this fixture.
import socket,json,subprocess,tempfile,pathlib,time,os,hashlib,shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='ndm-hrbeu-recovery-')); out=root/'downloads';out.mkdir();home=root/'home';home.mkdir()
def port():
 s=socket.socket();s.bind(('127.0.0.1',0));p=s.getsockname()[1];s.close();return p
hp,bp=port(),port()
while bp==hp:bp=port()
host=pathlib.Path(os.environ.get('NDM_QA_HOST_PATH', 'native/.build/release/NDMHost')).resolve()
env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'CFFIXED_USER_HOME':str(home),'NDM_SUPPORT_DIR':str(root/'engine'),'NDM_HOST_PORT':str(hp),'NDM_BRIDGE_PORT':str(bp),'NDM_DISABLE_LEGACY_BRIDGE':'1'}
log=open(root/'host.log','w');process=subprocess.Popen([str(host)],env=env,stdout=log,stderr=log)
def rpc(op,**fields):
 s=socket.create_connection(('127.0.0.1',hp),timeout=5);s.sendall((json.dumps(dict(id=98291,op=op,**fields))+'\n').encode())
 for line in s.makefile():
  d=json.loads(line)
  if d.get('id')==98291:s.close();return d
 raise RuntimeError('no response')
report={'root':str(root),'hostSHA':hashlib.sha256(host.read_bytes()).hexdigest()}
try:
 for _ in range(80):
  try:
   if rpc('ping').get('ok'):break
  except OSError:time.sleep(.1)
 response=rpc('add',url='https://www.hrbeu.edu.cn/__local/C/A2/B4/FEE5A8AA184531BAF36583D61EB_FAD75A67_3C99ACE.mp4?e=.mp4',folderPath=str(out),connections=32)
 assert response.get('ok'),response
 taskid=response['task']['id'];started=time.time(); print(json.dumps({'started':taskid,'root':str(root)}),flush=True)
 while time.time()-started<600:
  tasks=rpc('list')['tasks'];task=next(t for t in tasks if t['id']==taskid)
  print(json.dumps({k:task.get(k) for k in ['id','status','progress','completedBytes','fileSize','errorText']}),flush=True)
  if task['status'] in ['complete','error']:break
  time.sleep(10)
 report.update(status=task['status'],elapsed=round(time.time()-started,1),error=task.get('errorText'))
 file=next((p for p in out.iterdir() if p.is_file() and not p.name.startswith('.')),None)
 if task['status']=='complete' and file:
  report.update(bytes=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest())
 worklog=root/'engine'/str(taskid)/'LogFile.txt'
 if worklog.exists():shutil.copyfile(worklog,root/'transfer.log')
 report['passed']=report.get('bytes')==63544014 and report.get('sha256')=='b9ea30651a7ff2cd7bf5e8734b44b5316b59d4897ea4df9063eeb4b957fcef8b'
 assert report['passed'], 'Download must complete and match the independently verified Neat output'
finally:
 process.terminate()
 try:process.wait(timeout=5)
 except subprocess.TimeoutExpired:process.kill();process.wait()
 log.close()
 (root/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
 for folder in [out,root/'engine',home]:shutil.rmtree(folder,ignore_errors=True)
