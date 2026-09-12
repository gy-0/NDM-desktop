#!/usr/bin/env python3
"""Isolated real Host RPC/restart QA. Media subprocesses are controlled fixtures.

No browser, clipboard, production support directory, or external URL is used.
Pass a debug NDMHost built in a separate scratch directory; this does not build.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

HOST = Path(sys.argv[1]).resolve()
ROOT = Path(tempfile.mkdtemp(prefix="ndm-creation-receipts-qa-"))
SUPPORT = ROOT / "support"
TOOLS = ROOT / "tools"
SUPPORT.mkdir()
TOOLS.mkdir()
(ROOT / "downloads").mkdir()

def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

PORT, BRIDGE = port(), port()
ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "NDM_SUPPORT_DIR": str(SUPPORT),
       "NDM_HOST_PORT": str(PORT), "NDM_BRIDGE_PORT": str(BRIDGE),
       "NDM_DISABLE_LEGACY_BRIDGE": "1", "NDM_TOOL_DIR": str(TOOLS),
       "NDM_CREATION_QA_ROOT": str(ROOT)}
fake = TOOLS / "yt-dlp"
fake.write_text(f"#!{sys.executable}\n" + r'''
import hashlib, json, os, pathlib, sys, time
root = pathlib.Path(os.environ['NDM_CREATION_QA_ROOT'])
if '--version' in sys.argv:
    print('2026.09.12'); sys.exit(0)
if '-J' in sys.argv:
    url = sys.argv[-1]
    key = hashlib.sha256(url.encode()).hexdigest()[:12]
    with (root / 'probes.log').open('a') as log: log.write(url + '\n')
    (root / ('started-' + key)).touch()
    deadline = time.monotonic() + 25
    while not (root / ('release-' + key)).exists():
        if time.monotonic() > deadline: sys.exit(2)
        time.sleep(.02)
    if url.endswith('/media-fail') and not (root / 'allow-failed-probe').exists():
        print('ERROR: synthetic probe failure', file=sys.stderr); sys.exit(1)
    print(json.dumps({'id': 'fixture', 'title': 'Synthetic media', 'duration': 1,
        'webpage_url': url, 'formats': [{'format_id': 'fixture-720', 'height': 720,
        'vcodec': 'avc1', 'acodec': 'mp4a', 'ext': 'mp4', 'filesize': 1024,
        'url': 'http://127.0.0.1:9/fixture.mp4'}]}))
else:
    with (root / 'downloads.log').open('a') as log:
        log.write(('cached' if '--load-info-json' in sys.argv else 'fresh') + '\n')
    print('ERROR: synthetic transfer failure', file=sys.stderr); sys.exit(1)
''')
fake.chmod(0o700)
process = None
events = []

def rpc(op, **params):
    request = {"op": op, "id": 1, **params}
    with socket.create_connection(("127.0.0.1", PORT), timeout=3) as conn:
        conn.settimeout(35)
        conn.sendall((json.dumps(request) + "\n").encode())
        with conn.makefile("rb") as stream:
            for line in stream:
                reply = json.loads(line)
                if reply.get("id") == 1:
                    return reply
    raise AssertionError("RPC connection closed without a reply")

def drop_reply(op, **params):
    with socket.create_connection(("127.0.0.1", PORT), timeout=3) as conn:
        conn.sendall((json.dumps({"op": op, "id": 2, **params}) + "\n").encode())
        conn.shutdown(socket.SHUT_WR)
        # Intentionally close without reading any acknowledgement.

def eventually(check, timeout=10):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = check()
            if last: return last
        except (OSError, AssertionError):
            pass
        time.sleep(.03)
    raise AssertionError(f"Timed out; last observation: {last!r}")

def start():
    global process
    log = (ROOT / "host.log").open("ab")
    process = subprocess.Popen([str(HOST)], env=ENV, stdout=log, stderr=log, start_new_session=True)
    log.close()
    eventually(lambda: rpc("ping").get("ok"))
    assert rpc("updateSettings", downloadDirectory=str(ROOT / "downloads"), downloadAllAtOnce=True,
               useCategoryFolders=False, showCompletionDialog=False)["ok"]

def stop():
    global process
    if process is not None:
        # Only the isolated Host's own process group, including its fake tools.
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait(timeout=5)
        process = None

def receipt(key):
    return rpc("getCreationReceipt", creationKey=key)

def media_marker(prefix, url):
    return ROOT / (prefix + "-" + hashlib.sha256(url.encode()).hexdigest()[:12])

def media_request(url):
    return {"creationKey": str(uuid.uuid4()), "url": url,
            "formatID": "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
            "filename": "Synthetic", "container": "compactMKV", "subtitleLanguage": "en",
            "folderPath": str(ROOT / "downloads"), "connections": 7, "collectionScope": "current"}

try:
    start()
    ordinary = {"creationKey": str(uuid.uuid4()), "url": "http://127.0.0.1:9/opaque",
                "filename": "Report.pdf", "connections": 7, "autoStart": False,
                "folderPath": str(ROOT / "downloads"), "headers": ["X-Fixture: stable"]}
    drop_reply("add", **ordinary)
    accepted = eventually(lambda: (r if r.get("receipt") else None) if (r := receipt(ordinary["creationKey"])) else None)
    task_id = accepted["receipt"]["taskID"]
    assert accepted["task"]["filename"] == "Report.pdf"
    assert accepted["task"]["connections"] == 7
    assert len(rpc("list")["tasks"]) == 1
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        repeated = list(pool.map(lambda _: rpc("add", **ordinary), range(10)))
    assert all(r["ok"] and r["receipt"]["taskID"] == task_id for r in repeated)
    assert len(rpc("list")["tasks"]) == 1
    events.append({"scenario": "lost ordinary acknowledgement and 10 concurrent retries", "taskID": task_id, "taskCount": 1})
    stop(); start()
    assert receipt(ordinary["creationKey"])["receipt"]["taskID"] == task_id
    assert rpc("add", **ordinary)["task"]["status"] != "downloading"
    conflict = rpc("add", **{**ordinary, "filename": "Changed.pdf"})
    assert conflict.get("errorKind") == "creationIntentMismatch"
    assert rpc("remove", taskID=task_id, deleteFile=False)["ok"]
    deleted = rpc("add", **ordinary)
    assert deleted["ok"] and not deleted["receipt"]["taskExists"] and "task" not in deleted
    assert not rpc("list")["tasks"]
    events.append({"scenario": "restart, mismatched intent and deletion tombstone", "passed": True})

    # A full task and receipt commit before the work directory startup fails.
    (SUPPORT / "2").write_text("synthetic blocked work directory")
    failed_start = rpc("add", creationKey=str(uuid.uuid4()), url="http://127.0.0.1:9/fail.bin", autoStart=True,
                       folderPath=str(ROOT / "downloads"))
    assert failed_start["ok"] and failed_start["receipt"]["taskExists"]
    assert failed_start["task"]["status"] in ["error", "failed"], failed_start
    events.append({"scenario": "committed task survives startup error", "status": failed_start["task"]["status"]})

    media = media_request("http://127.0.0.1:9/media-one")
    drop_reply("addMedia", **media)
    eventually(lambda: media_marker("started", media["url"]).exists())
    preparing = receipt(media["creationKey"])
    assert preparing["receipt"] is None and preparing.get("pending") is True
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        repeated_media = pool.submit(rpc, "addMedia", **media)
        mismatch = rpc("addMedia", **{**media, "container": "compatibleMP4"})
        assert mismatch.get("errorKind") == "creationIntentMismatch"
        media_marker("release", media["url"]).touch()
        media_accepted = repeated_media.result(timeout=15)
    assert media_accepted["ok"], media_accepted
    media_id = media_accepted["receipt"]["taskID"]
    assert media_accepted["task"]["filename"] == "Synthetic.mkv"
    assert media_accepted["task"]["connections"] == 7
    probe_count = (ROOT / "probes.log").read_text().count(media["url"])
    eventually(lambda: receipt(media["creationKey"]).get("task", {}).get("status") == "error")
    # The existing engine retries one failed cached extraction without cache.
    # Capture after settlement, so that retry cannot be mistaken for a replay.
    attempts = (ROOT / "downloads.log").read_text().splitlines()
    assert attempts == ["cached", "fresh"], attempts
    stop(); start()
    media_replay = rpc("addMedia", **media)
    assert media_replay["receipt"]["taskID"] == media_id
    assert media_replay["task"]["status"] == "error"
    assert (ROOT / "probes.log").read_text().count(media["url"]) == probe_count
    assert (ROOT / "downloads.log").read_text().splitlines() == attempts
    events.append({"scenario": "media pending, lost acknowledgement, concurrency and restart", "taskID": media_id,
                   "probeCount": probe_count, "transferAttempts": attempts, "taskCount": 1})
    assert rpc("remove", taskID=media_id, deleteFile=False)["ok"]
    deleted_media = rpc("addMedia", **media)
    assert deleted_media["ok"] and deleted_media["receipt"] == {"taskID": media_id, "taskExists": False}
    assert "task" not in deleted_media
    assert rpc("addMedia", **{**media, "filename": "Other"}).get("errorKind") == "creationIntentMismatch"
    assert (ROOT / "probes.log").read_text().count(media["url"]) == probe_count
    events.append({"scenario": "media deletion and changed intent cannot resurrect task", "passed": True})

    crash = media_request("http://127.0.0.1:9/media-crash")
    drop_reply("addMedia", **crash)
    eventually(lambda: media_marker("started", crash["url"]).exists())
    assert receipt(crash["creationKey"]).get("pending")
    stop(); start()
    empty = receipt(crash["creationKey"])
    assert empty["receipt"] is None and not empty.get("pending")
    media_marker("release", crash["url"]).touch()
    recovered = rpc("addMedia", **crash)
    assert recovered["ok"] and recovered["receipt"]["taskExists"]
    assert len([t for t in rpc("list")["tasks"] if t["url"] == crash["url"]]) == 1
    events.append({"scenario": "process termination during media preparation; same intent safely resumes", "passed": True})

    failed = media_request("http://127.0.0.1:9/media-fail")
    media_marker("release", failed["url"]).touch()
    assert not rpc("addMedia", **failed)["ok"]
    empty = receipt(failed["creationKey"])
    assert empty["receipt"] is None and not empty.get("pending")
    (ROOT / "allow-failed-probe").touch()
    assert rpc("addMedia", **failed)["ok"]
    assert len([t for t in rpc("list")["tasks"] if t["url"] == failed["url"]]) == 1
    assert rpc("addMedia", **{**media, "collectionScope": "all"}).get("errorKind") == "creationCollectionUnsupported"
    assert rpc("getCreationReceipt", creationKey="bad").get("errorKind") == "invalidCreationKey"
    events.append({"scenario": "media preparation rejection can retry; unsupported/invalid requests reject", "passed": True})
    assert (SUPPORT / "Preflight").is_dir()
    (ROOT / "result.json").write_text(json.dumps({"passed": True, "events": events}, ensure_ascii=False, indent=2))
    print(json.dumps({"root": str(ROOT), "passed": True, "events": events}, ensure_ascii=False, indent=2))
finally:
    stop()
    if not (ROOT / "result.json").exists():
        (ROOT / "result.json").write_text(json.dumps({"passed": False, "events": events}, indent=2))
        print("Failure evidence:", ROOT, file=sys.stderr)
