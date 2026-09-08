const test = require('node:test');
const assert = require('node:assert/strict');
const outbox = require('../relay-outbox.js');
const copy = value => structuredClone(value);
function session(initial = {}) {
    let data = copy(initial), writes = 0, fail = false;
    return {
        async get(key) { return copy({[key]:data[key]}); },
        async set(values) { writes++; if(fail) throw Error('fixture write failed'); data = {...data,...copy(values)}; },
        data: () => copy(data), writes: () => writes, fail: value => { fail=value; }
    };
}
function ids() { let n=0; return ()=>'fixture_request_'+String(++n).padStart(8,'0'); }
const payload = '1:POST\r\n2:https://fixture.invalid/file\r\nCookie: session=fixture\r\n__0NeatPostData9__:body=fixture';

test('accepted requests persist before result and survive a replacement worker unchanged',async()=>{
    const storage=session(); const first=outbox.create({storage,idFactory:ids(),now:()=>123});
    const receipt=await first.admit(payload); assert.equal(receipt.accepted,true);
    assert.equal(storage.data()[outbox.key].items[0].requestId,receipt.requestId);
    const second=outbox.create({storage,idFactory:()=> 'second_worker_request_123',now:()=>456});
    assert.deepEqual(await second.snapshot(),await first.snapshot());
    await second.ack(receipt.requestId);
    assert.deepEqual(await outbox.create({storage,idFactory:ids()}).snapshot(),[]);
});
test('delayed restore precedes concurrent admission and writes never overlap',async()=>{
    const base=session(); const old=outbox.create({storage:base,idFactory:()=> 'original_request_123'});
    await old.admit('original');
    let restore; let active=0,maxActive=0;
    const storage={get:()=>new Promise(resolve=>{restore=()=>base.get(outbox.key).then(resolve);}),set:async value=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,5));await base.set(value);active--;}};
    const next=outbox.create({storage,idFactory:ids()});
    const a=next.admit('a'),b=next.admit('b');
    await new Promise(resolve=>setImmediate(resolve));assert.equal(base.writes(),1);
    restore();await Promise.all([a,b]);
    assert.deepEqual((await next.snapshot()).map(x=>x.payload),['original','a','b']);assert.equal(maxActive,1);
});
test('write and delete failures retain accepted state and later operations can recover',async()=>{
    const storage=session();const box=outbox.create({storage,idFactory:ids()});
    const first=await box.admit(payload);storage.fail(true);
    assert.deepEqual(await box.admit('new'),{accepted:false,error:'storage-failed'});
    await assert.rejects(box.ack(first.requestId));assert.equal((await box.snapshot()).length,1);
    assert.equal(storage.data()[outbox.key].items.length,1);
    storage.fail(false);assert.deepEqual(await box.ack(first.requestId),{removed:true});
    assert.equal((await box.admit('retry')).accepted,true);
});
test('queue full never evicts first request and unknown ACK cannot delete any item',async()=>{
    const storage=session();const box=outbox.create({storage,idFactory:ids()});
    for(let i=0;i<21;i++)assert.equal((await box.admit('item'+i)).accepted,true);
    assert.deepEqual(await box.admit('newest'),{accepted:false,error:'queue-full'});
    const writes=storage.writes();assert.deepEqual(await box.ack('unknown_id_123456'),{removed:false});assert.equal(storage.writes(),writes);
    assert.equal((await box.snapshot())[0].payload,'item0');
});
test('ID collisions cannot replace payload and equal payload under fresh ID is intentional',async()=>{
    const storage=session();let id='fixed_request_12345';const box=outbox.create({storage,idFactory:()=>id});
    const a=await box.admit('one');assert.deepEqual(await box.admit('one'),a);assert.equal(storage.writes(),1);
    assert.deepEqual(await box.admit('different'),{accepted:false,error:'id-conflict'});
    id='another_request_12345';await box.admit('one');assert.equal((await box.snapshot()).length,2);
});
test('UTF8 and JSON escaping are counted using the final envelope',async()=>{
    const box=outbox.create({storage:session(),idFactory:ids()});
    for(const value of ['界'.repeat(40000),'\\'.repeat(60000),'\n'.repeat(60000)]) {
        assert.equal((await box.admit(value)).error,'request-too-large');
    }
    const ascii='x'.repeat(118000);assert.equal((await box.admit(ascii)).accepted,true);
    assert.ok(Buffer.byteLength(outbox.envelope((await box.snapshot())[0].requestId,ascii))<=118784);
});
test('caller snapshot mutation cannot alter internal or persisted data',async()=>{
    const storage=session();const box=outbox.create({storage,idFactory:ids()});await box.admit(payload);
    const snapshot=await box.snapshot();snapshot[0].payload='changed';snapshot.push({});
    assert.equal((await box.snapshot())[0].payload,payload);assert.equal(storage.data()[outbox.key].items.length,1);
});
test('missing storage, failed read and malformed restored state fail closed without overwriting',async()=>{
    const missing=outbox.create({idFactory:ids()});await assert.rejects(missing.ready,/unavailable/);await assert.rejects(missing.admit('x'));
    const failed=outbox.create({storage:{get:async()=>{throw Error('read failed');},set:async()=>assert.fail('must not overwrite')},idFactory:ids()});await assert.rejects(failed.ready,/read failed/);
    for(const state of [{version:2,items:[]},{version:1,items:[{requestId:'short',payload:'x',createdAt:1}]},{version:1,items:Array(22).fill({requestId:'fixture_request_123',payload:'x',createdAt:1})},{version:1,items:[{requestId:'fixture_request_123',payload:'x'.repeat(9*1024*1024),createdAt:1}]}]) {
        const storage=session({[outbox.key]:state}),box=outbox.create({storage,idFactory:ids()});
        await assert.rejects(box.ready,/invalid-session/);await assert.rejects(box.admit('new'));assert.equal(storage.writes(),0);
    }
});

test('admission remains pending until session.set succeeds',async()=>{
    const base=session();let release;
    const storage={get:base.get,set:value=>new Promise(resolve=>{release=async()=>{await base.set(value);resolve();};})};
    const box=outbox.create({storage,idFactory:ids()});let returned=false;
    const pending=box.admit(payload).then(value=>{returned=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(returned,false);assert.equal(base.data()[outbox.key],undefined);
    await release();assert.equal((await pending).accepted,true);assert.equal(base.data()[outbox.key].items.length,1);
});
