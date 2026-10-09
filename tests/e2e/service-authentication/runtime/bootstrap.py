"""Prepare one test-owned root-only receiver volume; never issue production keys."""

import json
import os
import pathlib
import shutil
import sys

root = pathlib.Path("/run/antnest-auth")
for item in root.iterdir():
    if item.is_dir() and not item.is_symlink():
        shutil.rmtree(item)
    else:
        item.unlink()
os.chown(root, 0, 0)
os.chmod(root, 0o700)
mode = sys.argv[1]
source = json.loads(pathlib.Path("/fixture/input.json").read_text())
target = root / "callers.json"
target.write_text(source["callers_raw"])
os.chown(target, 0, 0)
os.chmod(target, 0o600)
tunnel = root / "tunnel.json"
tunnel.write_text(source["tunnel_raw"])
os.chown(tunnel, 0, 0)
os.chmod(tunnel, 0o600)
if mode == "empty":
    target.unlink()
elif mode == "directory-mode":
    os.chmod(root, 0o755)
elif mode == "file-mode":
    os.chmod(target, 0o644)
elif mode == "owner":
    os.chown(root, 1000, 1000)
    os.chown(target, 1000, 1000)
elif mode == "link":
    target.unlink()
    target.symlink_to("/fixture/input.json")
elif mode == "fifo":
    target.unlink()
    os.mkfifo(target, 0o600)
elif mode == "extra":
    (root / "unexpected").write_text("extra file")
elif mode != "valid":
    raise ValueError("unknown fixture mode")
