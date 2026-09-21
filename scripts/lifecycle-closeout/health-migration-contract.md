# Runtime health acceptance migration

Own the health acceptance consumer only; preserve preceding uncommitted batches.
Use current Foundation setup, private Temporal, immutable Runtime image and
exact lifecycle replay. No service/SDK changes, retained deployment mutations,
old asset removal, SIGKILL, clock or export tuning.

Retain two 60-second idle CPU measurements, a bounded unprivileged CPU load,
startup probe timing, actual steady Engine cadence and three failed probes.
CPU sampling must not cross a Runtime restart. Pause only the owned Runtime
with SIGSTOP, and always resume it with SIGCONT even on cancellation. Verify
Controller's unhealthy state and ACP's offline state before resuming. Same-process
health recovery must preserve the execution binding, image, mounts and workspace.

Then stop the idle Runtime normally and require exit zero; start that same
container and check fresh startup probes. A changed process identity must not
silently reactivate the Agent, even after Engine health recovers. Confirm the
closed binding and ACP offline state over repeated observations, then explicitly
Rebuild the same Template revision. Require replacement compute, a new Runtime
and execution revision, retained workspace and no Run/model activity. Normal
Delete must remove owned compute/storage before teardown.

Trace Create/Rebuild/Delete with current lifecycle oracles and preserve strict
warnings/errors. Container health, Agent binding and ACP access are independent
assertions. Add negative tests first, run local and Docker gates serially, and
compare retained development identity/image/mount/health afterwards.
