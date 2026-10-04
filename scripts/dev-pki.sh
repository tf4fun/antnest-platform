#!/bin/sh
set -eu
pki_script_directory=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec node "$pki_script_directory/dev-pki.mjs" "$@"
