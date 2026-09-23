#!/bin/sh
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
: "${ANTNEST_EGRESS_TEST_DATABASE_URL:?run make test-postgres for isolated dependencies}"
cargo test --manifest-path services/runtime-egress/Cargo.toml --locked --lib --test postgres_repository -- --ignored --test-threads=1
node tests/support/verification/go-service.mjs runtime-controller
npm --prefix services/agent-acp-service run test:postgres
node tests/support/verification/go-service.mjs identity-service
node tests/support/verification/go-service.mjs agent-controller
