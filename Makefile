.PHONY: fmt fmt-check lint go-vet rust-clippy test test-go test-rust test-egress-postgres docker-build compose-up compose-down e2e-stage1

GOCACHE := $(CURDIR)/.cache/go-build

fmt:
	gofmt -w $$(find services -name '*.go' -type f)
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all

fmt-check:
	@test -z "$$(gofmt -l $$(find services -name '*.go' -type f))"
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all --check
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all --check

lint: go-vet rust-clippy

go-vet:
	GOCACHE=$(GOCACHE) go vet -p=1 ./services/runtime-controller/... ./services/runtime-provider-docker/...

rust-clippy:
	cargo clippy --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --all-targets -- -D warnings
	cargo clippy --manifest-path services/runtime-egress/Cargo.toml --locked --all-targets -- -D warnings

test:
	$(MAKE) test-go
	$(MAKE) test-rust

test-go:
	GOCACHE=$(GOCACHE) go test -p=1 ./services/runtime-controller/... ./services/runtime-provider-docker/...

test-rust:
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked
	cargo test --manifest-path services/runtime-egress/Cargo.toml --locked

test-egress-postgres:
	docker compose up -d --wait postgres
	docker compose exec -T postgres dropdb --if-exists --force -U antnest_egress antnest_egress_test
	docker compose exec -T postgres createdb -U antnest_egress antnest_egress_test
	ANTNEST_EGRESS_TEST_DATABASE_URL=postgres://antnest_egress:$${ANTNEST_EGRESS_POSTGRES_PASSWORD:-antnest-egress-dev}@127.0.0.1:55432/antnest_egress_test cargo test --manifest-path services/runtime-egress/Cargo.toml --locked --test postgres_repository -- --ignored --test-threads=1

docker-build:
	docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
	docker compose build runtime-egress

compose-up: docker-build
	docker compose up -d --wait postgres runtime-egress

compose-down:
	docker compose down --remove-orphans

e2e-stage1: docker-build
	sh scripts/e2e-stage1.sh
