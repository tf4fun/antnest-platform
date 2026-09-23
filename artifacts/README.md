# Local verification records

`verification/` stores durable private verification evidence, logs, reports,
screenshots, database backups and recovery inputs. It is excluded from Git and
Docker build contexts, but it is not a disposable cache. Preserve or explicitly
archive these records before removing them. Reports in `docs/` index relevant
local evidence; a fresh checkout does not contain private records.

Executable tests, assertions, shared tools and reusable command manifests belong
under `tests/`, not here. Historical raw source copies are recovery evidence only
when an explicit migration record identifies their current source or status.
Do not move new source through either this directory or `.cache/` before saving
it to its owning source directory.

Create evidence directories with mode 0700 and private files with mode 0600.
Never copy credentials, database contents or raw responses into versioned test
sources. `.cache/` is reserved for reproducible dependency/compiler caches.
