#!/usr/bin/env python3
"""Execute supplied original ARM64 instructions in Unicorn; no network or app launch.
Requires unicorn==2.1.4. Tested binary is pinned by SHA256. Requeue tests hook only
cleanup and state publication, so these are function-level tests, not full app QA.
"""
import argparse, hashlib, json, random, struct
from pathlib import Path
from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm64_const import UC_ARM64_REG_SP, UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_LR, UC_ARM64_REG_PC
EXPECTED='25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7'
a=argparse.ArgumentParser(); a.add_argument('binary',type=Path); a.add_argument('--output',type=Path,required=True); args=a.parse_args()
binary=args.binary.read_bytes(); digest=hashlib.sha256(binary).hexdigest()
assert digest==EXPECTED, 'Unknown binary; rederive addresses before executing'
uc=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
assert struct.unpack_from('<I',binary)[0]==0xfeedfacf
cursor=32
for _ in range(struct.unpack_from('<I',binary,16)[0]):
    cmd,size=struct.unpack_from('<II',binary,cursor)
    if cmd==0x19:
        name=struct.unpack_from('<16s',binary,cursor+8)[0].rstrip(b'\0')
        vm,vs,fo,fs=struct.unpack_from('<QQQQ',binary,cursor+24)
        if name!=b'__PAGEZERO' and vs:
            uc.mem_map(vm,(vs+4095)&~4095)
            if fs:uc.mem_write(vm,binary[fo:fo+fs])
    cursor+=size
BASE=0x200000000; MAN=BASE; VECTOR=BASE+0x1000; SEG=BASE+0x2000; ENGINE=BASE+0x20000; SOCKET=BASE+0x22000; STACK=BASE+0x80000; STOP=BASE+0xff000
uc.mem_map(BASE,0x100000)
def q(address,value):uc.mem_write(address,struct.pack('<Q',value&((1<<64)-1)))
def i(address,value):uc.mem_write(address,struct.pack('<I',value&0xffffffff))
def setup(remaining,mode=0,states=None,alternate=False,total=0):
    uc.mem_write(MAN,bytes(0x1000));uc.mem_write(SEG,bytes(0x10000))
    uc.mem_write(MAN+8,bytes([int(alternate)]));i(MAN+0xa8,mode);q(MAN+0x10,total)
    q(MAN+0x68,VECTOR);q(MAN+0x70,VECTOR+len(remaining)*8)
    for index,r in enumerate(remaining):
        s=SEG+index*0x100;q(VECTOR+index*8,s)
        q(s+0x30,100);q(s+0x40,r+100);i(s+0x50,states[index] if states else 2)
def call(address,x0=MAN,x1=0,x2=0):
    uc.reg_write(UC_ARM64_REG_SP,STACK);uc.reg_write(UC_ARM64_REG_LR,STOP)
    uc.reg_write(UC_ARM64_REG_X0,x0);uc.reg_write(UC_ARM64_REG_X1,x1);uc.reg_write(UC_ARM64_REG_X2,x2)
    uc.emu_start(address,STOP,count=100000)
    assert uc.reg_read(UC_ARM64_REG_PC)==STOP,'Execution did not return within instruction budget'
    return uc.reg_read(UC_ARM64_REG_X0)
cases=[]
rng=random.Random(20260908)
arrays=[[],[0],[204800],[204801],[237568],[237569],[1,1000000,1000000],[1000000,0,2]]
arrays += [[rng.randrange(0,8*1024*1024) for _ in range(rng.randrange(1,33))] for _ in range(128)]
for alternate in [False,True]:
    split=0x80000 if alternate else 0x32000; capacity=0x88000 if alternate else 0x3a000
    for n,remaining in enumerate(arrays):
        states=[1 if rng.randrange(7)==0 else 2 for _ in remaining]
        setup(remaining,alternate=alternate,states=states,total=32000000)
        eligible=[j for j,r in enumerate(remaining) if r>split]
        expected=max(eligible,key=lambda j:remaining[j]) if eligible else (0xffffffff if remaining else 0)
        actual=call(0x10005e2b4)&0xffffffff;assert actual==expected,(remaining,actual,expected)
        expected=sum(r//capacity+1 for r in remaining if r>0) if remaining else 32000000//capacity
        actual=call(0x10005e1e0);assert actual==expected,(remaining,actual,expected)
        for mode in [0,1]:
            i(MAN+0xa8,mode)
            expected=int(not remaining or any(s==1 or (mode==0 and r>capacity) for s,r in zip(states,remaining)))
            actual=call(0x10005e120);assert actual==expected,(mode,remaining,actual,expected)
        cases.append({'case':n,'alternateThresholds':alternate,'segments':len(remaining),'checks':4,'pass':True})
# Execute the real HTTP requeue decision. Bypass socket resource cleanup and event
# dispatch only, which otherwise require the original process/runtime environment.
published=[]
def hook(machine,address,size,data):
    if address==0x100054554:
        machine.reg_write(UC_ARM64_REG_PC,machine.reg_read(UC_ARM64_REG_LR))
    elif address==0x100052a30:
        published.append(machine.reg_read(UC_ARM64_REG_X1))
        machine.reg_write(UC_ARM64_REG_PC,machine.reg_read(UC_ARM64_REG_LR))
h=uc.hook_add(UC_HOOK_CODE,hook)
requeue=[]
for label,remaining,shouldContinue,engineState,expected in [
 ('large unfinished tail',[4*1024*1024],1,2,0),
 ('small tail',[200000],1,2,7),
 ('exact work threshold',[237568],1,2,7),
 ('above work threshold',[237569],1,2,0),
 ('stop requested',[4000000],0,2,7),
 ('all bytes complete',[0],1,2,7),
 ('startup allocation',[0],1,1,0)]:
    setup(remaining);uc.mem_write(SOCKET,bytes(0x1000));uc.mem_write(ENGINE,bytes(0x1000))
    q(SOCKET+0x200,ENGINE);q(ENGINE+0x5f8,MAN);i(ENGINE+0x598,engineState)
    published.clear();call(0x10003bd14,SOCKET,shouldContinue,0)
    assert published==[expected],(label,published,expected)
    requeue.append({'case':label,'socketState':published[0],'pass':True})
result={'binarySha256':digest,'execution':'original ARM64 machine code in Unicorn; synthetic object memory','selectorCases':len(cases),'selectorAssertions':len(cases)*4,'requeueCases':requeue,'limitations':['not a full-app network test','requeue cleanup and state-event publication are intercepted','does not prove timing, throughput, server compatibility, or the full scheduler'],'cases':cases}
args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='cases'},ensure_ascii=False))
