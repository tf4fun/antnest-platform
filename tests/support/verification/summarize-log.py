import argparse
import hashlib
import json
import os
import pathlib
import re
from configuration import durable_path

os.umask(0o077)
parser = argparse.ArgumentParser(description="Summarize JSON results in verification logs.")
parser.add_argument("--output", required=True, type=pathlib.Path)
parser.add_argument("logs", nargs="+", help="Input log paths, relative to the current directory or absolute.")
args = parser.parse_args()
args.output = durable_path(args.output)
args.logs = [str(durable_path(name)) for name in args.logs]
args.output.mkdir(parents=True, exist_ok=True)

decoder = json.JSONDecoder()
for name in args.logs:
    f = pathlib.Path(name)
    s = f.read_text()
    objects = []
    for m in re.finditer(r"(?m)^\{", s):
        try:
            row, _ = decoder.raw_decode(s[m.start():])
        except ValueError:
            continue
        if isinstance(row, dict) and any(
            k in row
            for k in ["status", "result", "scenario", "diagnostic", "strict_exit", "structural_failures"]
        ):
            objects.append(row)
    (args.output / (f.stem + ".parsed.json")).write_text(
        json.dumps(
            {"log_sha256": hashlib.sha256(f.read_bytes()).hexdigest(), "objects": objects},
            indent=2,
        )
    )
    summaries = []
    for row in objects:
        v = {
            k: (len(row[k]) if isinstance(row[k], list) else row[k])
            for k in [
                "status", "result", "scenario", "diagnostic", "profile", "strict_exit",
                "audit_traces", "execution_traces", "lifecycle_traces", "gateway_connections",
                "strict_warning_failures",
            ]
            if k in row
        }
        for k in [
            "scenarios", "structural_failures", "traces", "request_traces", "watch_traces",
            "policy_traces", "lifecycle_traces",
        ]:
            if isinstance(row.get(k), list):
                v[k] = len(row[k])
        if v:
            summaries.append(v)
    print(json.dumps({"log": name, "summaries": summaries}, ensure_ascii=False))
