"""Resolved workspace paths must not turn a marker read into a cache read."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from configuration import durable_path
from controller17_acceptance import WORKSPACE_READ


class Controller17WorkspaceTests(unittest.TestCase):
    def test_resolved_paths_keep_full_bytes_and_reject_cache_or_workspace_escape(self):
        with tempfile.TemporaryDirectory(dir=durable_path(tempfile.gettempdir())) as temporary:
            root=Path(temporary).resolve()
            for name,body in [('readlink','printf "%s" "$RESOLVED"'),('cat','printf " marker\\n"; printf called > "$CALL_MARKER"')]:
                path=root/name;path.write_text('#!/bin/sh\n'+body+'\n');path.chmod(0o700)
            for resolved,accepted in [('/workspace/note.txt',True),('/workspace/.cache/note.txt',False),('/workspace/nested/.cache/note.txt',False),('/tmp/note.txt',False)]:
                with self.subTest(resolved=resolved):
                    marker=root/'called';marker.unlink(missing_ok=True)
                    result=subprocess.run(['/bin/sh','-c',WORKSPACE_READ,'sh','/workspace/note.txt'],env={**os.environ,'PATH':str(root),'RESOLVED':resolved,'CALL_MARKER':str(marker)},capture_output=True,timeout=5)
                    self.assertEqual(result.returncode==0,accepted)
                    self.assertEqual(marker.exists(),accepted)
                    self.assertEqual(result.stdout,b' marker\n' if accepted else b'')


if __name__=='__main__':unittest.main()
