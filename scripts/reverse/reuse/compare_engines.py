"""Same-server original vs current native engine comparison; synthetic data only."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time


def compare(host_path, root, original_submit, original_snapshot, fixture_port, original_port, requests, payload, free_port):
    workspace = root/'native-comparison'
    workspace.mkdir()
    home, support, output = [workspace/name for name in ['home','support','downloads']]
    for directory in [home,support,output]: directory.mkdir()
    port, bridge = free_port(), free_port()
    while bridge == port: bridge = free_port()
    host_path = Path(host_path).resolve()
    env = {'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'CFFIXED_USER_HOME':str(home),
           'TMPDIR':str(workspace),'LANG':'en_US.UTF-8','NDM_SUPPORT_DIR':str(support),
           'NDM_HOST_PORT':str(port),'NDM_BRIDGE_PORT':str(bridge),'NDM_DISABLE_LEGACY_BRIDGE':'1'}
    sequence = 0
    def rpc(operation, **fields):
        nonlocal sequence
        sequence += 1
        with socket.create_connection(('127.0.0.1',port),timeout=10) as conn:
            conn.sendall((json.dumps({'id':sequence,'op':operation,**fields})+'\n').encode())
            with conn.makefile('r') as stream:
                for line in stream:
                    reply=json.loads(line)
                    if reply.get('id')==sequence:
                        if not reply.get('ok'): raise RuntimeError(reply)
                        return reply
        raise RuntimeError('Native RPC closed without reply')
    report={'hostSHA256':hashlib.sha256(host_path.read_bytes()).hexdigest(),'cases':[],
            'scope':'Original macOS 1.3 and current release Swift host; same synthetic server/payload, fixed four requested connections. Not Electron UI or public Internet speed proof.',
            'measurementNotes':[
                'Original snapshot refresh is 200 ms; current RPC is polled every 25 ms. Observed progress/completion timings include this asymmetry.',
                'First useful server body uses the same server monotonic clock for both engines and excludes one-byte probes; it is not a client paint timestamp.',
                'Normal: 64 KiB writes every 8 ms per connection. Latency: additionally wait 150 ms before each response header.',
                'A 600 ms idle interval before submission is outside measurement to avoid the original admission gate.'
            ]}
    with (workspace/'host.log').open('wb') as log:
        host=subprocess.Popen([str(host_path)],env=env,cwd=workspace,stdout=log,stderr=subprocess.STDOUT)
        try:
            deadline=time.monotonic()+30
            while True:
                if host.poll() is not None: raise RuntimeError('Native comparison host exited')
                try: rpc('ping');break
                except (OSError,RuntimeError):
                    if time.monotonic()>deadline: raise
                    time.sleep(.05)
            assert rpc('list')['tasks']==[]
            settings=rpc('updateSettings',downloadDirectory=str(output),useCategoryFolders=False,maxConnections=4,smartConnections=False)['settings']
            assert settings['maxConnections']==4 and settings['smartConnections'] is False, settings
            report['currentSettings']=settings
            for scenario in ['normal','latency']:
                for trial in range(3):
                    # Alternate order to reduce consistent warm-cache/order bias.
                    order=['original','current'] if trial%2==0 else ['current','original']
                    for engine in order:
                        time.sleep(.6)  # Outside measurement; original's 500 ms admission gate.
                        path=f'/compare/{scenario}-{trial}-{engine}.bin'
                        url=f'http://127.0.0.1:{fixture_port}{path}'
                        started=time.monotonic(); samples=[]
                        if engine=='original': key=str(original_submit(url,original_port))
                        else: key=str(rpc('add',url=url,filename=path.rsplit('/',1)[1],folderPath=str(output),connections=4)['task']['id'])
                        accepted=time.monotonic()
                        deadline=started+60
                        while time.monotonic()<deadline:
                            if engine=='original':
                                raw=original_snapshot()
                                task=next((r for r in raw.get('records',[]) if str(r['id'])==key),None)
                                live=next((t for t in raw.get('tasks',[]) if str(t['id'])==key),{})
                                progress=live.get('engineProgress') or {}
                                size=progress.get('completedBytes',0)
                                complete=task and task['status']=='Complete'
                                error=task and str(task['status']).startswith('Error')
                                destination=Path(task['folderpath'])/task['filename'] if complete else None
                            else:
                                task=next(t for t in rpc('list')['tasks'] if str(t['id'])==key)
                                size=task['completedBytes'];complete=task['status']=='complete';error=task['status']=='error'
                                destination=Path(task['folderPath'])/task['filename'] if complete else None
                            samples.append({'elapsedMS':round((time.monotonic()-started)*1000,2),'bytes':size})
                            if error: raise RuntimeError(f'{engine} comparison failed: {task}')
                            if complete: break
                            time.sleep(.025)
                        else: raise TimeoutError(f'{engine} {scenario} completion')
                        finished=time.monotonic()
                        expected=hashlib.sha256(payload).hexdigest()
                        assert hashlib.sha256(destination.read_bytes()).hexdigest()==expected
                        observed=[dict(r) for r in requests if r.get('path')==path]
                        useful=[r for r in observed if r.get('firstBodyMonotonic') and r['end']-r['start']+1>1 and r.get('method')!='HEAD']
                        case={'engine':engine,'scenario':scenario,'trial':trial,'taskID':key,'bytes':len(payload),'sha256':expected,
                              'acceptMS':round((accepted-started)*1000,2),'elapsedMS':round((finished-started)*1000,2),
                              'firstRequestMS':round((min(r['monotonic'] for r in observed)-started)*1000,2),
                              'firstUsefulServerBodyMS':round((min(r['firstBodyMonotonic'] for r in useful)-started)*1000,2),
                              'firstObservedProgressMS':next((s['elapsedMS'] for s in samples if s['bytes']>0),None),
                              'requests':observed,'samples':samples}
                        report['cases'].append(case)
                        print(json.dumps({k:v for k,v in case.items() if k not in ['requests','samples']}),flush=True)
            report['passed']=True
        finally:
            try:
                if host.poll() is None:
                    try: rpc('pauseAll')
                    finally:
                        # Only this owned synthetic-test child, even if RPC failed.
                        host.terminate();host.wait(timeout=15)
            finally:
                report['hostStopped']=host.poll() is not None
                (workspace/'report.json').write_text(json.dumps(report,indent=2))
    return report
