#!/bin/sh
set -eu
gate=/workspace/.c3-update-gate
if [ -f "$gate" ]; then
    cat "$gate" > /workspace/.c3-update-entered
    while [ -f "$gate" ]; do sleep 0.1; done
fi
exec /usr/local/bin/antnest-runtime serve
