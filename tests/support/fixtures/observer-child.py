"""Local process tree for observer cleanup contracts; never contacts Docker."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(os.environ['OBSERVER_FIXTURE_ROOT'])
mode = sys.argv[1]
if mode == 'worker':
    if os.environ.get('OBSERVER_IGNORE_TERM') == 'true':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (root / 'worker.pid').write_text(str(os.getpid()))
    while True:
        time.sleep(0.05)

(root / 'parent.json').write_text(json.dumps({'pid': os.getpid(), 'pgid': os.getpgrp()}))
print('antnest-stage3-e2e-12345', flush=True)
worker = subprocess.Popen([sys.executable, __file__, 'worker'])
while not (root / 'worker.pid').exists():
    time.sleep(0.01)
if mode == 'parent-exits':
    (root / 'ready').touch()
    raise SystemExit(int(os.environ.get('OBSERVER_EXIT_CODE', '0')))
if mode == 'clean-trigger':
    def stop(signum, frame):
        worker.terminate()
        worker.wait(timeout=2)
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
(root / 'ready').touch()
worker.wait()
