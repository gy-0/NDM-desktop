"""Same-server original vs current native engine comparison; synthetic data only."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time


def compare(host_path, root, original_submit, original_snapshot, fixture_port, original_port, requests, payload, free_port, *, pause_verify=None, original_command=None, scenarios=('normal','latency')):
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
            'payloadBytes':len(payload), 'pauseResume':bool(pause_verify), 'scenarios':list(scenarios),
            'measurementNotes':[
                'Original snapshot refresh is 200 ms; current RPC is polled every 25 ms. Observed progress/completion timings include this asymmetry.',
                'First useful server body uses the same server monotonic clock for both engines and excludes one-byte probes; it is not a client paint timestamp.',
                'Normal: 64 KiB writes every 8 ms per connection. Latency: additionally wait 150 ms before each response header. Redirect: two 302 hops and final response each wait 150 ms.',
                'Progress milestones use the first observed byte count at or above 10/25/50/75/90 percent; completion supplies the final byte count. Rates include snapshot sampling delay.',
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
            for scenario in scenarios:
                for trial in range(3):
                    # Alternate order to reduce consistent warm-cache/order bias.
                    order=['original','current'] if trial%2==0 else ['current','original']
                    for engine in order:
                        time.sleep(.6)  # Outside measurement; original's 500 ms admission gate.
                        path=f'/compare/{scenario}-{trial}-{engine}.bin'
                        url=f'http://127.0.0.1:{fixture_port}{path}'
                        started=time.monotonic(); samples=[]; pause_evidence=None; resumed_at=None
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
                            if complete: size=len(payload)
                            samples.append({'elapsedMS':round((time.monotonic()-started)*1000,2),'bytes':size})
                            if error: raise RuntimeError(f'{engine} comparison failed: {task}')
                            if complete: break
                            if pause_verify and pause_evidence is None and size >= len(payload)*.25:
                                pause_started=time.monotonic()
                                if engine=='original':
                                    original_key=live['key']
                                    pause_evidence=pause_verify(original_key)
                                    paused_bytes=pause_evidence['state']['engineProgress']['completedBytes']
                                    durable_bytes=sum(item['size'] for item in pause_evidence['segments'].values())
                                else:
                                    rpc('pause',taskID=int(key))
                                    acknowledged=time.monotonic()
                                    paused=next(t for t in rpc('list')['tasks'] if str(t['id'])==key)
                                    assert paused['status']=='paused', paused
                                    paused_bytes=paused['completedBytes']
                                    def partials():
                                        files={str(p.relative_to(support/key)):{'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
                                               for p in (support/key).rglob('*') if p.is_file() and p.name!='LogFile.txt'}
                                        receipt=json.loads((support/key/'offset-storage-v2.json').read_text())
                                        assert Path(receipt['parentPath']).resolve()==output.resolve()
                                        assert Path(receipt['partialName']).name==receipt['partialName']
                                        partial=output/receipt['partialName']
                                        files['payload:'+partial.name]={'size':partial.stat().st_size,'sha256':hashlib.sha256(partial.read_bytes()).hexdigest()}
                                        return files
                                    before=partials()
                                    receipt=json.loads((support/key/'offset-storage-v2.json').read_text())
                                    durable_bytes=sum(part['durablePrefix'] for part in receipt['ranges'])
                                    assert before and 0 < paused_bytes < len(payload)
                                    time.sleep(1)
                                    assert partials()==before, 'Current paused files changed'
                                    pause_evidence={'segments':before,'stableForOneSecond':True,'pauseAcknowledgedMS':round((acknowledged-pause_started)*1000,2)}
                                resumed_at=time.monotonic()
                                if engine=='original': original_command('resume',original_key)
                                else: rpc('resume',taskID=int(key))
                                pause_evidence.update({'pausedBytes':paused_bytes,'durableBytes':durable_bytes,'pauseIntervalMS':round((resumed_at-pause_started)*1000,2),
                                                       'resumeAcknowledgedMS':round((time.monotonic()-resumed_at)*1000,2)})
                            time.sleep(.025)
                        else: raise TimeoutError(f'{engine} {scenario} completion')
                        finished=time.monotonic()
                        expected=hashlib.sha256(payload).hexdigest()
                        assert hashlib.sha256(destination.read_bytes()).hexdigest()==expected
                        paths = {path} if scenario != 'redirect' else {path, path.replace('/redirect-', '/hop-', 1), path.replace('/redirect-', '/object-', 1)}
                        observed=[dict(r) for r in requests if r.get('path') in paths]
                        if scenario == 'redirect':
                            assert {r['path'] for r in observed} == paths, 'Both redirect hops and object must be observed'
                            assert sum(r.get('status') == 302 for r in observed) >= 2
                        useful=[r for r in observed if r.get('firstBodyMonotonic') and r['end']-r['start']+1>1 and r.get('method')!='HEAD']
                        case={'engine':engine,'scenario':scenario,'trial':trial,'taskID':key,'bytes':len(payload),'sha256':expected,
                              'acceptMS':round((accepted-started)*1000,2),'elapsedMS':round((finished-started)*1000,2),
                              'firstRequestMS':round((min(r['monotonic'] for r in observed)-started)*1000,2),
                              'firstUsefulServerBodyMS':round((min(r['firstBodyMonotonic'] for r in useful)-started)*1000,2),
                              'firstObservedProgressMS':next((s['elapsedMS'] for s in samples if s['bytes']>0),None),
                              'requests':observed,'samples':samples}
                        milestones={str(percent):next((sample['elapsedMS'] for sample in samples if sample['bytes'] >= len(payload)*percent/100),None) for percent in [10,25,50,75,90,100]}
                        assert all(value is not None for value in milestones.values()), milestones
                        case['progressMilestonesMS']=milestones
                        # Central half excludes most connection setup and final publication.
                        central_seconds=(milestones['75']-milestones['25'])/1000
                        case['centralHalfMiBPerSecond']=(len(payload)/2/1024/1024/central_seconds) if central_seconds>0 else None
                        case['overallMiBPerSecond']=len(payload)/1024/1024/(finished-started)
                        if pause_verify:
                            assert pause_evidence is not None and resumed_at is not None, 'Fixture completed before pause'
                            resumed=[r for r in useful if r['monotonic']>=resumed_at]
                            assert resumed, 'No useful request after resume'
                            written=sum(r.get('bodyBytesWritten',0) for r in observed if r['monotonic']>=resumed_at)
                            pause_evidence.update({'resumeToUsefulServerBodyMS':round((min(r['firstBodyMonotonic'] for r in resumed)-resumed_at)*1000,2),
                                                   'resumeToCompleteMS':round((finished-resumed_at)*1000,2),
                                                   'postResumeServerBodyBytesWritten':written,
                                                   'serverWritesBeyondDurableRemainder':written-(len(payload)-pause_evidence['durableBytes']),
                                                   'postResumeRequests':len([r for r in observed if r['monotonic']>=resumed_at])})
                            case['pauseResume']=pause_evidence
                            # Milestones cross the deliberate stop; don't present them as steady throughput.
                            case['centralHalfMiBPerSecond']=None
                            case['overallMiBPerSecond']=None
                        if scenario == 'disconnect':
                            faults = [r for r in observed if r.get('forcedDisconnectMonotonic')]
                            assert len(faults) == 1, 'Must interrupt exactly one established nonzero ranged response'
                            fault = faults[0]
                            repaired = [r for r in useful if r['monotonic'] > fault['forcedDisconnectMonotonic'] and r['start'] <= fault['end'] and r['end'] >= fault['start']]
                            assert repaired, 'Interrupted interval must be requested again'
                            first = min(repaired, key=lambda r:r['firstBodyMonotonic'])
                            prefix = [r for r in repaired if fault['start'] < r['start'] <= fault['start']+fault['bodyBytesWritten']]
                            continuation = min(prefix, key=lambda r:r['firstBodyMonotonic']) if prefix else None
                            case['disconnectRecovery'] = {
                                'faultedRange': [fault['start'], fault['end']],
                                'serverBytesWrittenBeforeDisconnect': fault['bodyBytesWritten'],
                                'firstRepairRange': [first['start'], first['end']],
                                'repairToFirstBodyMS': round((first['firstBodyMonotonic']-fault['forcedDisconnectMonotonic'])*1000,2),
                                'nonzeroPrefixReused': continuation is not None,
                                'prefixRepairRange': [continuation['start'], continuation['end']] if continuation else None,
                                'prefixRepairToFirstBodyMS': round((continuation['firstBodyMonotonic']-fault['forcedDisconnectMonotonic'])*1000,2) if continuation else None,
                                'healthyWorkerBodyAfterFault': any(r is not fault and not r.get('forcedDisconnectMonotonic') and r['monotonic'] < fault['forcedDisconnectMonotonic'] < r.get('lastBodyMonotonic',0) for r in observed),
                                'exactOutputSHA256': expected
                            }
                        report['cases'].append(case)
                        print(json.dumps({k:v for k,v in case.items() if k not in ['requests','samples','pauseResume']}),flush=True)
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
