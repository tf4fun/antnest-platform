.PHONY: fmt fmt-check lint go-vet rust-clippy node-lint test test-go test-rust test-node test-egress-postgres test-runtime-controller-postgres test-agent-acp-postgres test-identity-postgres docker-build docker-build-runtime-controller compose-up compose-down e2e-stage1 e2e-runtime-controller

GOCACHE := $(CURDIR)/.cache/go-build
GOMODCACHE := $(CURDIR)/.cache/go-mod

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

lint: go-vet rust-clippy node-lint

go-vet:
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go vet -p=1 ./services/runtime-controller/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go vet -p=1 ./services/identity-service/...

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

test-rust:
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked
	cargo test --manifest-path services/runtime-egress/Cargo.toml --locked

test-node:
	npm --prefix services/agent-acp-service test

test-egress-postgres:
	docker compose up -d --wait postgres
	docker compose exec -T postgres dropdb --if-exists --force -U antnest_egress antnest_egress_test
	docker compose exec -T postgres createdb -U antnest_egress antnest_egress_test
	ANTNEST_EGRESS_TEST_DATABASE_URL=postgres://antnest_egress:$${ANTNEST_EGRESS_POSTGRES_PASSWORD:-antnest-egress-dev}@127.0.0.1:55432/antnest_egress_test cargo test --manifest-path services/runtime-egress/Cargo.toml --locked --test postgres_repository -- --ignored --test-threads=1

test-runtime-controller-postgres:
	docker compose up -d --wait runtime-controller-postgres
	docker compose exec -T runtime-controller-postgres dropdb --if-exists --force -U antnest_runtime_controller antnest_runtime_controller_test
	docker compose exec -T runtime-controller-postgres createdb -U antnest_runtime_controller antnest_runtime_controller_test
	ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL=postgres://antnest_runtime_controller:$${ANTNEST_RUNTIME_CONTROLLER_POSTGRES_PASSWORD:-antnest-runtime-controller-dev}@127.0.0.1:55433/antnest_runtime_controller_test GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/runtime-controller/internal/repository/postgres -run TestRepository -count=1

test-agent-acp-postgres:
	docker compose up -d --wait agent-acp-postgres
	docker compose exec -T agent-acp-postgres dropdb --if-exists --force -U antnest_agent_acp antnest_agent_acp_test
	docker compose exec -T agent-acp-postgres createdb -U antnest_agent_acp antnest_agent_acp_test
	ANTNEST_ACP_TEST_DATABASE_URL=postgres://antnest_agent_acp:$${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@127.0.0.1:55434/antnest_agent_acp_test npm --prefix services/agent-acp-service run test:postgres

test-identity-postgres:
	docker compose --profile stage2 up -d --wait identity-postgres
	docker compose exec -T identity-postgres dropdb --if-exists --force -U antnest_identity antnest_identity_test
	docker compose exec -T identity-postgres createdb -U antnest_identity antnest_identity_test
	ANTNEST_IDENTITY_TEST_DATABASE_URL=postgres://antnest_identity:$${ANTNEST_IDENTITY_POSTGRES_PASSWORD:-antnest-identity-dev}@127.0.0.1:55435/antnest_identity_test GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/identity-service/internal/repository ./services/identity-service/internal/e2e -count=1

docker-build-runtime-controller:
	docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
	docker compose build runtime-egress
	docker compose build runtime-controller

docker-build: docker-build-runtime-controller
	docker compose build agent-acp-service
	docker compose --profile stage2 build identity-service

compose-up: docker-build-runtime-controller
	docker compose up -d --wait postgres runtime-egress runtime-controller-postgres runtime-controller

compose-down:
	docker compose down --remove-orphans

e2e-stage1: docker-build-runtime-controller
	sh scripts/e2e-stage1.sh

e2e-runtime-controller: docker-build-runtime-controller
	sh services/runtime-controller/scripts/e2e.sh
