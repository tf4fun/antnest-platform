#!/bin/sh
# Linux CI entry point. The owner joins privileged dependency installers before
# recovery/retry and downloads Chromium with the invoking user's HOME/cache.
set -eu

[ "$#" -eq 1 ] || { echo "usage: ci-install-chromium.sh <playwright binary>" >&2; exit 1; }
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$directory/ci-install-chromium.py" "$1"
