"""Owned fixture for packaged Electron QA; stdin EOF shuts it down."""
import json
from pathlib import Path
import sys
from original_socks import SocksFixture

proxy = SocksFixture(int(sys.argv[1]))
try:
    print(json.dumps({'port': proxy.port}), flush=True)
    for _ in sys.stdin:
        pass
finally:
    proxy.close()
    Path(sys.argv[2]).write_text(json.dumps({'routes': proxy.routes, 'stopped': True}, indent=2))
