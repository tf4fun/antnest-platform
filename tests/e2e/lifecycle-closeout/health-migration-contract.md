# Runtime health contract

This document defines what the Runtime health profile
(`make e2e-lifecycle-health`) must prove. It uses the Foundation setup, private
Temporal, an immutable Runtime image and exact lifecycle replay. It requires no
service or SDK changes, and it uses no SIGKILL and no clock or export tuning.

## Measurements

The profile takes two 60-second idle CPU measurements, a bounded unprivileged CPU
load, startup probe timing, the actual steady Engine health cadence and three
failed probes. CPU sampling must not cross a Runtime restart.

## Required behavior

- Only the owned Runtime is paused with SIGSTOP, and it is always resumed with
  SIGCONT, even on cancellation. The Controller's unhealthy state and ACP's
  offline state are verified before resuming.
- Health recovery within the same process must preserve the execution binding,
  image, mounts and workspace.
- The idle Runtime is then stopped normally (exit zero) and the same container is
  started again with fresh startup probes. A changed process identity must not
  silently reactivate the Agent, even after Engine health recovers. The closed
  binding and ACP offline state are confirmed over repeated observations.
- An explicit Rebuild of the same Template revision must produce replacement
  compute, a new Runtime and execution revision, a retained workspace and no Run
  or model activity.
- A normal Delete removes owned compute and storage before teardown.

Container health, Agent binding and ACP access are independent assertions.

## Trace and verification rules

Create, Rebuild and Delete are checked with the lifecycle Trace oracles, and
strict warnings and errors are preserved. Negative tests come first; local and
Docker checks run serially. Other running containers keep their identity, image,
mounts and health.
