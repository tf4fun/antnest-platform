#!/bin/sh
# Installs Playwright's headless Chromium and its system packages on a CI
# runner. The runner's Ubuntu mirror sometimes stops answering mid-transfer,
# and apt then waits until the job times out, so each attempt is bounded and
# a stalled attempt is retried.
set -eu

playwright=${1:?usage: ci-install-chromium.sh <playwright binary>}
[ -x "$playwright" ] || { echo "Playwright is not installed: $playwright" >&2; exit 1; }
attempts=${ANTNEST_CHROMIUM_INSTALL_ATTEMPTS:-3}
budget=${ANTNEST_CHROMIUM_INSTALL_BUDGET:-8m}

attempt=1
while :; do
  if timeout --kill-after=30s "$budget" "$playwright" install --with-deps --only-shell chromium; then
    exit 0
  fi
  [ "$attempt" -lt "$attempts" ] || break
  echo "::warning::Chromium install attempt $attempt failed or stalled; retrying"
  # A killed apt run can leave dpkg mid-transaction.
  sudo dpkg --configure -a || true
  attempt=$((attempt + 1))
done
echo "Chromium install failed after $attempts attempts" >&2
exit 1
