# Local verification artifacts

This directory holds local, private output from verification runs. Only this
README is versioned; a fresh checkout contains no records.

`verification/` stores durable private evidence: logs, reports, screenshots,
Trace exports, database backups and recovery inputs written by test runners and
suites. It is excluded from Git and Docker build contexts, but it is not a
disposable cache. Archive or explicitly remove records when they are no longer
needed.

Executable tests, assertions, shared tools and reusable command manifests
belong under `tests/`, not here. Do not stage new source files through this
directory or through `.cache/`; save them directly in their owning source
directory. `.cache/` is reserved for reproducible dependency and compiler
caches.

Create evidence directories with mode 0700 and private files with mode 0600.
Never copy credentials, database contents or raw responses into versioned test
sources.
