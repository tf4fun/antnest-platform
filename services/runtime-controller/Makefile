.PHONY: fmt fmt-check lint test test-postgres e2e

GOCACHE := $(abspath ../../.cache/go-build)
GOMODCACHE := $(abspath ../../.cache/go-mod)
GOLANGCI_LINT_CACHE := $(abspath ../../.cache/golangci-lint)

fmt:
	gofmt -w ./cmd ./internal

fmt-check:
	@test -z "$$(gofmt -l ./cmd ./internal)" || \
		{ gofmt -l ./cmd ./internal; exit 1; }

lint:
	GOLANGCI_LINT_CACHE=$(GOLANGCI_LINT_CACHE) GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) golangci-lint run ./...

test:
	go test -p=1 ./...

test-postgres:
	@test -n "$$ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL" || \
		{ echo "ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL is required" >&2; exit 1; }
	go test -p=1 ./internal/repository/postgres -run TestRepository -count=1

e2e:
	$(MAKE) -C ../.. e2e-runtime-controller
