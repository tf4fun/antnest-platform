.PHONY: fmt fmt-check lint go-lint rust-clippy node-lint test test-go test-rust test-node test-managed-mcp-fixtures test-postgres test-egress-postgres test-runtime-controller-postgres test-agent-acp-postgres test-identity-postgres test-agent-controller-postgres docker-build docker-build-runtime-controller docker-build-agent-ui docker-build-stage3 compose-up compose-down e2e-stage1 e2e-stage2 e2e-stage3 e2e-runtime-controller

GOCACHE := $(CURDIR)/.cache/go-build
GOMODCACHE := $(CURDIR)/.cache/go-mod
GOLANGCI_LINT_CACHE := $(CURDIR)/.cache/golangci-lint
POSTGRES_ADMIN_USER := antnest_test_admin

define reset-test-database
	docker compose up -d --wait postgres
	docker compose exec -T postgres dropdb --if-exists --force -U $(POSTGRES_ADMIN_USER) $(2)
	docker compose exec -T postgres createdb -U $(POSTGRES_ADMIN_USER) -O $(1) $(2)
	docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U $(POSTGRES_ADMIN_USER) -d postgres -c "REVOKE CONNECT ON DATABASE $(2) FROM PUBLIC"
endef

fmt:
	services/agent-acp-service/node_modules/.bin/prettier --write scripts/rpc-response-loss/*.mjs scripts/acp-persistence/*.mjs scripts/acp-restart/*.mjs
	gofmt -w $$(find services -name '*.go' -type f)
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all
	npm --prefix services/agent-acp-service run format
	services/agent-acp-service/node_modules/.bin/prettier --write scripts/lifecycle-closeout/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --write scripts/workspace-closeout/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --write scripts/deployment.test.mjs
	services/agent-acp-service/node_modules/.bin/prettier --write scripts/observability/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --write scripts/verification/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --write services/admin-console/tests/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --write services/edge-gateway/tests/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --write scripts/managed-mcp/*.mjs scripts/acp-closeout/*.mjs scripts/identity-closeout/*.mjs scripts/acp-progress/*.mjs scripts/acp-files/*.mjs scripts/acp-plan/*.mjs scripts/acp-permissions/*.mjs scripts/acp-commands/*.mjs scripts/acp-multimodal/*.mjs scripts/acp-cost/*.mjs

fmt-check:
	services/agent-acp-service/node_modules/.bin/prettier --check scripts/rpc-response-loss/*.mjs scripts/acp-persistence/*.mjs scripts/acp-restart/*.mjs
	@unformatted="$$(gofmt -l $$(find services -name '*.go' -type f))" || exit $$?; \
		test -z "$$unformatted"
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all --check
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all --check
	npm --prefix services/agent-acp-service run format:check
	services/agent-acp-service/node_modules/.bin/prettier --check scripts/lifecycle-closeout/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --check scripts/workspace-closeout/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --check scripts/deployment.test.mjs
	services/agent-acp-service/node_modules/.bin/prettier --check scripts/observability/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --check scripts/verification/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --check services/admin-console/tests/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --check services/edge-gateway/tests/*.mjs
	services/agent-acp-service/node_modules/.bin/prettier --check scripts/managed-mcp/*.mjs scripts/acp-closeout/*.mjs scripts/identity-closeout/*.mjs scripts/acp-progress/*.mjs scripts/acp-files/*.mjs scripts/acp-plan/*.mjs scripts/acp-permissions/*.mjs scripts/acp-commands/*.mjs scripts/acp-multimodal/*.mjs scripts/acp-cost/*.mjs

lint: go-lint rust-clippy node-lint

go-lint:
	GOLANGCI_LINT_CACHE=$(GOLANGCI_LINT_CACHE) GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) golangci-lint run ./services/runtime-controller/... ./services/identity-service/... ./services/agent-controller/... ./services/admin-console/... ./services/edge-gateway/...

rust-clippy:
	cargo clippy --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --all-targets -- -D warnings
	cargo clippy --manifest-path services/runtime-egress/Cargo.toml --locked --all-targets -- -D warnings

node-lint:
	node --check scripts/verification/go-service.mjs
	node --check services/admin-console/tests/shutdown-docker.mjs
	node --check services/edge-gateway/tests/shutdown-docker.mjs
	npm --prefix services/agent-acp-service run lint
	npm --prefix services/agent-acp-service run typecheck
	npm --prefix services/admin-console/web run typecheck
	npm --prefix services/agent-ui/web run typecheck

test:
	$(MAKE) test-go
	$(MAKE) test-rust
	$(MAKE) test-node

test-go:
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/runtime-controller/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/identity-service/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/agent-controller/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/admin-console/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/edge-gateway/...

test-rust:
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --example managed-mcp-fixture
	cargo test --manifest-path services/runtime-egress/Cargo.toml --locked

test-node:
	node --test scripts/verification/*.test.mjs
	node --test scripts/deployment.test.mjs
	node --test scripts/observability/*.test.mjs
	node --test --test-concurrency=1 services/agent-acp-service/scripts/stage2-*.test.mjs
	npm --prefix services/agent-acp-service test
	npm --prefix services/admin-console/web test
	npm --prefix services/agent-ui/web test
	$(MAKE) test-managed-mcp-fixtures
	$(MAKE) test-rpc-response-loss-fixtures
	$(MAKE) test-acp-persistence-fixtures
	$(MAKE) test-acp-restart-fixtures
	$(MAKE) test-tool-progress-fixtures
	$(MAKE) test-file-observation-fixtures
	$(MAKE) test-plan-fixtures
	$(MAKE) test-permission-fixtures
	$(MAKE) test-command-fixtures
	$(MAKE) test-multimodal-fixtures
	$(MAKE) test-cost-fixtures
	$(MAKE) test-stage3-base-fixtures
	$(MAKE) test-lifecycle-fixtures
	$(MAKE) test-workspace-fixtures
	node --test --test-concurrency=1 scripts/acp-closeout/*.test.mjs
	node --test --test-concurrency=1 scripts/identity-closeout/*.test.mjs

test-managed-mcp-fixtures:
	node --test --test-concurrency=1 scripts/managed-mcp/*.test.mjs

.PHONY: test-rpc-response-loss-fixtures
test-rpc-response-loss-fixtures:
	node --test --test-concurrency=1 scripts/rpc-response-loss/*.test.mjs

.PHONY: test-lifecycle-fixtures e2e-lifecycle
test-lifecycle-fixtures:
	node --test --test-concurrency=1 scripts/lifecycle-closeout/*.test.mjs

e2e-lifecycle:
	node scripts/lifecycle-closeout/run.mjs

.PHONY: e2e-lifecycle-shutdown
e2e-lifecycle-shutdown:
	node scripts/lifecycle-closeout/run.mjs shutdown

.PHONY: test-workspace-fixtures e2e-workspace
test-workspace-fixtures:
	node --test --test-concurrency=1 scripts/workspace-closeout/*.test.mjs

e2e-workspace:
	node scripts/workspace-closeout/run.mjs

.PHONY: e2e-lifecycle-interrupted
e2e-lifecycle-interrupted:
	node scripts/lifecycle-closeout/interrupted-run.mjs

.PHONY: e2e-lifecycle-network
e2e-lifecycle-network:
	node scripts/lifecycle-closeout/run.mjs network

.PHONY: e2e-lifecycle-loss
e2e-lifecycle-loss:
	node scripts/lifecycle-closeout/run.mjs loss

.PHONY: e2e-rpc-response-loss
e2e-rpc-response-loss:
	ANTNEST_E2E_RPC_RESPONSE_LOSS=true sh scripts/e2e-stage3a.sh

.PHONY: test-tool-progress-fixtures e2e-tool-progress
test-tool-progress-fixtures:
	node --test --test-concurrency=1 scripts/acp-progress/*.test.mjs

e2e-tool-progress:
	ANTNEST_E2E_TOOL_PROGRESS=true sh scripts/e2e-stage3a.sh

.PHONY: test-file-observation-fixtures e2e-file-observations
test-file-observation-fixtures:
	node --test --test-concurrency=1 scripts/acp-files/*.test.mjs

e2e-file-observations:
	ANTNEST_E2E_FILE_OBSERVATIONS=true sh scripts/e2e-stage3a.sh

.PHONY: test-plan-fixtures e2e-structured-plan
test-plan-fixtures:
	node --test --test-concurrency=1 scripts/acp-plan/*.test.mjs

e2e-structured-plan:
	ANTNEST_E2E_STRUCTURED_PLAN=true sh scripts/e2e-stage3a.sh

.PHONY: test-permission-fixtures e2e-tool-permissions
test-permission-fixtures:
	node --test --test-concurrency=1 scripts/acp-permissions/*.test.mjs

e2e-tool-permissions:
	ANTNEST_E2E_TOOL_PERMISSIONS=true sh scripts/e2e-stage3a.sh

.PHONY: test-command-fixtures e2e-slash-commands
test-command-fixtures:
	node --test --test-concurrency=1 scripts/acp-commands/*.test.mjs

e2e-slash-commands:
	ANTNEST_E2E_SLASH_COMMANDS=true sh scripts/e2e-stage3a.sh

.PHONY: test-multimodal-fixtures e2e-multimodal
test-multimodal-fixtures:
	node --test --test-concurrency=1 scripts/acp-multimodal/*.test.mjs

e2e-multimodal:
	ANTNEST_E2E_MULTIMODAL=true sh scripts/e2e-stage3a.sh

.PHONY: test-cost-fixtures e2e-session-cost
test-cost-fixtures:
	node --test --test-concurrency=1 scripts/acp-cost/*.test.mjs

e2e-session-cost:
	ANTNEST_E2E_SESSION_COST=true sh scripts/e2e-stage3a.sh

test-postgres:
	sh scripts/test-postgres.sh

test-egress-postgres:
	$(call reset-test-database,antnest_egress,antnest_egress_test)
	ANTNEST_EGRESS_TEST_DATABASE_URL=postgres://antnest_egress:$${ANTNEST_EGRESS_POSTGRES_PASSWORD:-antnest-egress-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_egress_test \
	ANTNEST_EGRESS_TEST_ADMIN_DATABASE_URL=postgres://antnest_test_admin:$${ANTNEST_POSTGRES_ADMIN_PASSWORD:-antnest-postgres-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_egress_test \
	cargo test --manifest-path services/runtime-egress/Cargo.toml --locked --lib --test postgres_repository -- --ignored --test-threads=1

test-runtime-controller-postgres:
	$(call reset-test-database,antnest_runtime_controller,antnest_runtime_controller_test)
	ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL=postgres://antnest_runtime_controller:$${ANTNEST_RUNTIME_CONTROLLER_POSTGRES_PASSWORD:-antnest-runtime-controller-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_runtime_controller_test GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/runtime-controller/internal/repository/postgres -run TestRepository -count=1

test-agent-acp-postgres:
	$(call reset-test-database,antnest_agent_acp,antnest_agent_acp_test)
	ANTNEST_ACP_TEST_DATABASE_URL=postgres://antnest_agent_acp:$${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_agent_acp_test npm --prefix services/agent-acp-service run test:postgres

test-identity-postgres:
	$(call reset-test-database,antnest_identity,antnest_identity_test)
	ANTNEST_IDENTITY_TEST_DATABASE_URL=postgres://antnest_identity:$${ANTNEST_IDENTITY_POSTGRES_PASSWORD:-antnest-identity-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_identity_test GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/identity-service/internal/repository ./services/identity-service/internal/e2e -count=1

test-agent-controller-postgres:
	$(call reset-test-database,antnest_agent_controller,antnest_agent_controller_test)
	ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL=postgres://antnest_agent_controller:$${ANTNEST_AGENT_CONTROLLER_POSTGRES_PASSWORD:-antnest-agent-controller-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_agent_controller_test GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/agent-controller/internal/repository/postgres ./services/agent-controller/internal/e2e -count=1

docker-build-runtime-controller:
	docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
	docker compose build runtime-egress
	docker compose build runtime-controller

docker-build: docker-build-runtime-controller
	docker compose build agent-acp-service
	docker compose --profile stage2 build identity-service
	docker compose --profile stage2 build agent-controller

docker-build-agent-ui:
	docker build -f services/agent-ui/Dockerfile -t antnest/agent-ui:local .

docker-build-stage3: docker-build-runtime-controller
	docker compose --profile stage3 build agent-acp-service
	docker compose --profile stage3 build identity-service
	docker compose --profile stage3 build agent-controller
	docker compose --profile stage3 build admin-console
	docker compose --profile stage3 build agent-ui
	docker compose --profile stage3 build edge-gateway

compose-up: docker-build-runtime-controller
	docker compose up -d --wait postgres runtime-egress runtime-controller

compose-down:
	docker compose down --remove-orphans

e2e-stage1: docker-build-runtime-controller
	sh scripts/e2e-stage1.sh

e2e-stage2: docker-build
	sh scripts/e2e-stage2.sh

e2e-stage3: docker-build-stage3
	sh scripts/e2e-stage3a.sh

.PHONY: test-stage3-base-fixtures e2e-stage3-local
test-stage3-base-fixtures:
	node --test --test-concurrency=1 scripts/stage3-base/*.test.mjs

e2e-stage3-local:
	sh scripts/e2e-stage3a.sh

.PHONY: e2e-identity-access e2e-identity-core
e2e-identity-core:
	ANTNEST_E2E_IDENTITY_CORE=true sh scripts/e2e-stage3a.sh

e2e-identity-access:
	ANTNEST_E2E_IDENTITY_ACCESS=true sh scripts/e2e-stage3a.sh

.PHONY: e2e-acp-session
e2e-acp-session:
	ANTNEST_E2E_ACP_SESSION=true sh scripts/e2e-stage3a.sh

.PHONY: e2e-acp-closeout
e2e-acp-closeout:
	ANTNEST_E2E_ACP_CLOSEOUT=true sh scripts/e2e-stage3a.sh

.PHONY: e2e-agent-access
e2e-agent-access:
	ANTNEST_E2E_AGENT_ACCESS=true sh scripts/e2e-stage3a.sh

e2e-runtime-controller: docker-build-runtime-controller
	sh services/runtime-controller/scripts/e2e.sh

.PHONY: e2e-managed-mcp-v1 e2e-managed-mcp-v2
e2e-managed-mcp-v1:
	ANTNEST_E2E_MANAGED_MCP=true ANTNEST_E2E_MANAGED_MCP_VERSION=1 sh scripts/e2e-stage3a.sh

e2e-managed-mcp-v2:
	ANTNEST_E2E_MANAGED_MCP=true ANTNEST_E2E_MANAGED_MCP_VERSION=2 sh scripts/e2e-stage3a.sh

.PHONY: test-acp-persistence-fixtures e2e-acp-persistence
test-acp-persistence-fixtures:
	node --test --test-concurrency=1 scripts/acp-persistence/*.test.mjs

e2e-acp-persistence:
	ANTNEST_E2E_ACP_PERSISTENCE=true sh scripts/e2e-stage3a.sh

.PHONY: test-acp-restart-fixtures e2e-acp-restart
test-acp-restart-fixtures:
	node --test --test-concurrency=1 scripts/acp-restart/*.test.mjs

e2e-acp-restart:
	ANTNEST_E2E_ACP_RESTART=true sh scripts/e2e-stage3a.sh
