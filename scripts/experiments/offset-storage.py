#!/usr/bin/env python3
"""Isolated storage feasibility experiment, NOT the production download engine.
32 disjoint offset writers; durable prefix checkpoint; abrupt child exit; resume.
No network traffic, user files, or engine state. Fixtures remain under temp root.
"""
import concurrent.futures, hashlib, json, os, pathlib, subprocess, sys, tempfile, threading

PARTS, PART_SIZE, BLOCK = 32, 1024 * 1024, 65536
TOTAL = PARTS * PART_SIZE

def block_bytes(part, block):
    return hashlib.shake_256(f'ndm-offset-fixture:{part}:{block}'.encode()).digest(BLOCK)

def run_child(root, crash):
    target, journal = root / 'download.partial', root / 'coverage.json'
    fd = os.open(target, os.O_RDWR | os.O_CREAT, 0o600)
    if journal.exists():
        state = json.loads(journal.read_text())
        assert state['version'] == 1 and state['size'] == TOTAL
        prefixes = state['prefixes']
    else:
        os.ftruncate(fd, TOTAL)  # Sparse logical allocation; not completed progress.
        prefixes = [0] * PARTS
    lock = threading.Lock()
    peak = 0
    def checkpoint():
        nonlocal peak
        # Completed writes precede durable metadata. Prefix updates hold this
        # lock; concurrent future writes can only make this checkpoint conservative.
        with lock:
            os.fsync(fd)
            data = json.dumps({'version': 1, 'size': TOTAL, 'prefixes': prefixes}).encode()
            temp = root / 'coverage.next'
            jfd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                assert os.write(jfd, data) == len(data)
                os.fsync(jfd)
            finally:
                os.close(jfd)
            peak = max(peak, sum(p.stat().st_blocks * 512 for p in root.iterdir() if p.is_file()))
            os.replace(temp, journal)
            dfd = os.open(root, os.O_RDONLY)
            try: os.fsync(dfd)
            finally: os.close(dfd)
            peak = max(peak, sum(p.stat().st_blocks * 512 for p in root.iterdir() if p.is_file()))
    def writer(part):
        start = prefixes[part]
        limit = PART_SIZE // 2 if crash else PART_SIZE
        for local in range(start, limit, BLOCK):
            data = block_bytes(part, local // BLOCK)
            offset = part * PART_SIZE + local
            done = 0
            while done < len(data):
                count = os.pwrite(fd, data[done:], offset + done)
                if count <= 0: raise OSError('short pwrite')
                done += count
            with lock: prefixes[part] = local + BLOCK
        checkpoint()
    with concurrent.futures.ThreadPoolExecutor(max_workers=PARTS) as pool:
        list(pool.map(writer, range(PARTS)))
    checkpoint()
    if crash:
        # Simulate bytes reaching disk after the last durable progress receipt.
        # Recovery must overwrite this uncommitted suffix, not trust file size.
        assert os.pwrite(fd, b'?' * BLOCK, prefixes[0]) == BLOCK
        os.fsync(fd)
    print(json.dumps({'crash': crash, 'uncommittedSuffix': crash, 'logicalBytes': os.fstat(fd).st_size,
                      'allocatedBytes': os.fstat(fd).st_blocks * 512,
                      'peakOwnedAllocatedBytes': peak, 'completedBytes': sum(prefixes)}), flush=True)
    if crash:
        os._exit(86)  # Abrupt process termination, deliberately no cleanup.
    os.close(fd)

if len(sys.argv) > 1:
    run_child(pathlib.Path(sys.argv[1]), sys.argv[2] == 'crash')
else:
    root = pathlib.Path(tempfile.mkdtemp(prefix='ndm-offset-feasibility-'))
    phases = []
    for mode, expected in [('crash', 86), ('resume', 0)]:
        result = subprocess.run([sys.executable, __file__, str(root), mode], capture_output=True, text=True)
        assert result.returncode == expected, result.stderr
        phases.append(json.loads(result.stdout))
    expected, actual = hashlib.sha256(), hashlib.sha256()
    for part in range(PARTS):
        for block in range(PART_SIZE // BLOCK): expected.update(block_bytes(part, block))
    with (root / 'download.partial').open('rb') as file:
        while chunk := file.read(BLOCK): actual.update(chunk)
    assert actual.digest() == expected.digest()
    assert phases[0]['completedBytes'] == TOTAL // 2
    assert phases[1]['completedBytes'] == TOTAL
    assert max(p['peakOwnedAllocatedBytes'] for p in phases) < TOTAL * 1.1
    print(json.dumps({'passed': True, 'scope': 'storage prototype only; not NDM engine or power-loss proof',
                      'root': str(root), 'parts': PARTS, 'sha256': actual.hexdigest(), 'phases': phases}))
