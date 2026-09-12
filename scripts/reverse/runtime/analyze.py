from pathlib import Path
import json,re,hashlib,sqlite3
root=Path('/tmp/neat-runtime-audit');support=root/'profile/Library/Application Support/org.ndm.reference.audit'
events=[json.loads(l) for l in (root/'http-events.jsonl').read_text().splitlines()]
samples=[json.loads(l) for l in (root/'disk-samples.jsonl').read_text().splitlines()]
expected=hashlib.sha256(bytes(range(256))*(128*1024*1024//256)).hexdigest()
conn=sqlite3.connect('file:'+str(support/'NeatDB.db')+'?mode=ro',uri=True)
results=[]
for id,url,status,filename,folder in conn.execute('select id,url,status,filename,folderpath from downloads'):
 if id==1:continue
 path='/'+url.split('/',3)[3];ev=[e for e in events if e['path']==path or (id==7 and e['case']=='hls') or (id==9 and e['case']=='hls-unique')]
 starts=[e for e in ev if e['event']=='start'];data=(Path(folder)/filename).read_bytes();digest=hashlib.sha256(data).hexdigest()
 want=hashlib.sha256((root/'fixture.ts').read_bytes()*96).hexdigest() if id==7 else expected
 if id==9:
  fixture=(root/'fixture.ts').read_bytes()
  want=hashlib.sha256(b''.join(fixture+bytes([0x47,0x1f,0xff,0x10])+i.to_bytes(8,'big')+bytes([0xff])*176 for i in range(96))).hexdigest()
 assert digest==want,(id,digest,want)
 assert status=='Complete'
 log=(support/str(id)/'LogFile.txt').read_text(errors='replace')
 results.append({'id':id,'url':url,'status':status,'filename':filename,'size':len(data),'sha256':digest,'hashMatches':True,'configuredConnections':list(dict.fromkeys(map(int,re.findall(r'MaxAllowedConnection = (\d+)',log)))),'largestSegmentCount':max(map(int,re.findall(r'now has (\d+) Segments',log)),default=None),'pauseOccurred':'-> Paused' in log,'resumedPlanLoaded':'loaded from segments.bin' in log,'requestCount':len(starts),'http429Count':sum(e['code']==429 for e in starts),'maxServerHandlers':max((e['active'] for e in starts),default=0)})
# A server handler may briefly remain counted after the peer closed a socket;
# this count is not a precise simultaneous TCP-connection count.
a=min(e['t'] for e in events if e['path']=='/slow/32.bin');b=min(e['t'] for e in events if e['path']=='/pause/pause.bin')
window=[s for s in samples if a<=s['t']<b];base=[s for s in samples if s['t']<a][-1]
peak=max(window,key=lambda x:x['allocated'])
disk={'scope':'32.bin transfer only; subtract pre-transfer baseline; 5 ms sampling','baselineAllocated':base['allocated'],'peakAllocatedDelta':peak['allocated']-base['allocated'],'fileSize':134217728,'peakRatio':(peak['allocated']-base['allocated'])/134217728,'samplingIsLowerBound':True}
result={'tests':results,'disk':disk,'invalidInitialProbe':{'id':1,'reason':'legacy tool incorrectly sent filename in field 3; original interprets it as second media URL','excluded':True},'limitations':['loopback HTTP, not HTTPS or Internet performance','server handler count can exceed live connections briefly after disconnect','sandbox, separate preferences and IPC port remap; original download engine instructions unchanged','HLS includes a second run with 96 uniquely tagged valid TS entries and byte-exact ordered-output verification; not encrypted/live HLS or arbitrary media'],'control':{'noPauseIDs':[2,3,4,5,7,8,9],'pauseResumeID':6}}
(root/'runtime-results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
