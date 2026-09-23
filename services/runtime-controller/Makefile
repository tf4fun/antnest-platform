.PHONY: fmt fmt-check lint test test-postgres e2e e2e-observation

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
	cd ../.. && node tests/integration/go/run.mjs runtime-controller --profile integration --package internal/repository/postgres -- -run TestRepository -count=1

e2e:
	$(MAKE) -C ../.. e2e-runtime-controller

e2e-observation:
	node ../../tests/e2e/runtime-controller/creation-observation-e2e.mjs

# Explicit fault component; excluded from the ordinary unit/normal-restart suite.
.PHONY: test-crash-recovery
test-crash-recovery:
	cd ../.. && ANTNEST_RUNTIME_CONTROLLER_CRASH_TEST=true GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs runtime-controller --profile e2e --package internal/control -- -run '^TestRuntimeUpdateProcessCrashRecovery$$' -count=1 -v -timeout=6m
