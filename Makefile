.PHONY: fmt fmt-check lint go-vet rust-clippy test test-go test-rust e2e-stage1 docker-build compose-up compose-down

GOCACHE := $(CURDIR)/.cache/go-build

fmt:
	gofmt -w $$(find services -name '*.go' -type f)
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all

fmt-check:
	@test -z "$$(gofmt -l $$(find services -name '*.go' -type f))"
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all --check

lint: go-vet rust-clippy

go-vet:
	GOCACHE=$(GOCACHE) go vet -p=1 ./services/runtime-controller/... ./services/runtime-egress/... ./services/runtime-provider-docker/...

rust-clippy:
	cargo clippy --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --all-targets -- -D warnings

test:
	$(MAKE) test-go
	$(MAKE) test-rust

test-go:
	GOCACHE=$(GOCACHE) go test -p=1 ./services/runtime-controller/... ./services/runtime-egress/... ./services/runtime-provider-docker/...

test-rust:
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked

e2e-stage1:
	ANTNEST_STAGE1_E2E=1 GOCACHE=$(GOCACHE) go test ./services/runtime-controller/internal/e2e -count=1 -timeout=5m

docker-build:
	docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
	docker compose build runtime-egress
	docker compose build runtime-provider-docker
	docker compose build runtime-controller

compose-up: docker-build
	docker compose up -d postgres runtime-egress runtime-provider-docker runtime-controller

compose-down:
	docker compose down --remove-orphans
