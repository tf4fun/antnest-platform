#!/bin/sh
set -eu
umask 077
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Use make e2e-agent-readiness' >&2; exit 1; }
exec node tests/e2e/agent-readiness/run.mjs
