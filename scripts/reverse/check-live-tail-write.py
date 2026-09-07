#!/usr/bin/env python3
"""Execute original ARM64 boundary arithmetic; intercepted writes are not disk QA."""
import argparse, hashlib, json, struct
from pathlib import Path
from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm64_const import UC_ARM64_REG_SP, UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_LR, UC_ARM64_REG_PC

parser = argparse.ArgumentParser()
parser.add_argument('binary', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
binary = args.binary.read_bytes()
digest = hashlib.sha256(binary).hexdigest()
assert digest == '25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7'
assert struct.unpack_from('<I', binary)[0] == 0xfeedfacf
machine = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
cursor = 32
for _ in range(struct.unpack_from('<I', binary, 16)[0]):
    command, size = struct.unpack_from('<II', binary, cursor)
    if command == 0x19:
        name = struct.unpack_from('<16s', binary, cursor + 8)[0].rstrip(b'\0')
        vm, vs, offset, length = struct.unpack_from('<QQQQ', binary, cursor + 24)
        if name != b'__PAGEZERO' and vs:
            machine.mem_map(vm, (vs + 4095) & ~4095)
            if length:
                machine.mem_write(vm, binary[offset:offset + length])
    cursor += size
BASE = 0x200000000
machine.mem_map(BASE, 0x100000)
SOCKET, SEGMENT, BUFFER, BYTES, FILE, VTABLE = [BASE + i * 0x1000 for i in range(6)]
STACK, STOP, WRITE = BASE + 0x80000, BASE + 0xff000, BASE + 0xfe000
def q(address, value):
    machine.mem_write(address, struct.pack('<Q', value))
def readq(address):
    return struct.unpack('<Q', machine.mem_read(address, 8))[0]
def call(address, x0, x1=0, x2=0):
    for register, value in [(UC_ARM64_REG_SP, STACK), (UC_ARM64_REG_LR, STOP), (UC_ARM64_REG_X0, x0), (UC_ARM64_REG_X1, x1), (UC_ARM64_REG_X2, x2)]:
        machine.reg_write(register, value)
    machine.emu_start(address, STOP, count=10000)
    assert machine.reg_read(UC_ARM64_REG_PC) == STOP
    return machine.reg_read(UC_ARM64_REG_X0)
writes, progress = [], []
def hook(uc, address, size, data):
    if address == WRITE:
        amount = uc.reg_read(UC_ARM64_REG_X2)
        writes.append(amount)
        uc.reg_write(UC_ARM64_REG_X0, amount)
    elif address == 0x100063fc8:
        progress.append(uc.reg_read(UC_ARM64_REG_X1))
        uc.reg_write(UC_ARM64_REG_X0, 0)  # bypass state publication/completion only
    else:
        return
    uc.reg_write(UC_ARM64_REG_PC, uc.reg_read(UC_ARM64_REG_LR))
machine.hook_add(UC_HOOK_CODE, hook)
results = []
for old_end, new_end, completed, buffered in [(4095, 2047, 1024, 2048), (4095, 2047, 1024, 512), (4095, 2047, 2047, 65536), (999999, 500000, 10000, 65536)]:
    machine.mem_write(BASE, bytes(0x7000))
    q(SOCKET + 0x70, SEGMENT); q(SOCKET + 0x78, FILE); q(SOCKET + 0x80, BUFFER)
    q(FILE, VTABLE); q(VTABLE + 0x30, WRITE)
    q(SEGMENT + 0x28, 0); q(SEGMENT + 0x30, completed)
    q(SEGMENT + 0x38, old_end); q(SEGMENT + 0x40, old_end + 1)
    q(BUFFER + 8, BYTES); q(BUFFER + 0x10, 131072); q(BUFFER + 0x18, buffered)
    machine.mem_write(BYTES, b'x')
    call(0x100063e04, SEGMENT, new_end, 0)
    remaining = new_end + 1 - completed
    assert readq(SEGMENT + 0x38) == new_end and readq(SEGMENT + 0x40) == new_end + 1
    assert call(0x100053a30, SOCKET) == min(131072 - buffered, remaining)
    writes.clear(); progress.clear()
    call(0x100053f50, SOCKET)
    expected = min(buffered, remaining)
    assert writes == [expected] and progress == [expected]
    assert readq(BUFFER + 0x18) == 0 and machine.mem_read(BYTES, 1) == b'\0'
    results.append(dict(oldEnd=old_end, newEnd=new_end, completed=completed, buffered=buffered, writeBytes=expected, passed=True))
report = dict(binarySha256=digest, cases=results, limitations=[
    'Synthetic socket/segment memory, not a running original application',
    'Virtual file write and progress/state publication intercepted',
    'Proves original length clipping after end mutation; does not prove locking, network request survival, or power-loss durability'])
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
