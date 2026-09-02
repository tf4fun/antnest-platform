.PHONY: fmt fmt-check lint go-lint rust-clippy node-lint test test-go test-rust test-node test-postgres test-egress-postgres test-runtime-controller-postgres test-agent-acp-postgres test-identity-postgres test-agent-controller-postgres docker-build docker-build-runtime-controller compose-up compose-down e2e-stage1 e2e-stage2 e2e-runtime-controller

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
	gofmt -w $$(find services -name '*.go' -type f)
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all
	npm --prefix services/agent-acp-service run format

fmt-check:
	@test -z "$$(gofmt -l $$(find services -name '*.go' -type f))"
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all --check
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all --check
	npm --prefix services/agent-acp-service run format:check

lint: go-lint rust-clippy node-lint

go-lint:
	GOLANGCI_LINT_CACHE=$(GOLANGCI_LINT_CACHE) GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) golangci-lint run ./services/runtime-controller/... ./services/identity-service/... ./services/agent-controller/...

rust-clippy:
	cargo clippy --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --all-targets -- -D warnings
	cargo clippy --manifest-path services/runtime-egress/Cargo.toml --locked --all-targets -- -D warnings

node-lint:
	npm --prefix services/agent-acp-service run lint
	npm --prefix services/agent-acp-service run typecheck

test:
	$(MAKE) test-go
	$(MAKE) test-rust
	$(MAKE) test-node

test-go:
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/runtime-controller/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/identity-service/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/agent-controller/...

test-rust:
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked
	cargo test --manifest-path services/runtime-egress/Cargo.toml --locked

test-node:
	npm --prefix services/agent-acp-service test

test-postgres:
	sh scripts/test-postgres.sh

test-egress-postgres:
	$(call reset-test-database,antnest_egress,antnest_egress_test)
	ANTNEST_EGRESS_TEST_DATABASE_URL=postgres://antnest_egress:$${ANTNEST_EGRESS_POSTGRES_PASSWORD:-antnest-egress-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_egress_test \
	ANTNEST_EGRESS_TEST_ADMIN_DATABASE_URL=postgres://antnest_test_admin:$${ANTNEST_POSTGRES_ADMIN_PASSWORD:-antnest-postgres-dev}@127.0.0.1:$${ANTNEST_POSTGRES_HOST_PORT:-55432}/antnest_egress_test \
	cargo test --manifest-path services/runtime-egress/Cargo.toml --locked --test postgres_repository -- --ignored --test-threads=1

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

compose-up: docker-build-runtime-controller
	docker compose up -d --wait postgres runtime-egress runtime-controller

compose-down:
	docker compose down --remove-orphans

e2e-stage1: docker-build-runtime-controller
	sh scripts/e2e-stage1.sh

e2e-stage2: docker-build
	sh scripts/e2e-stage2.sh

e2e-runtime-controller: docker-build-runtime-controller
	sh services/runtime-controller/scripts/e2e.sh
