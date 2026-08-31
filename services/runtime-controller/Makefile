.PHONY: fmt fmt-check lint test test-postgres e2e

fmt:
	gofmt -w ./cmd ./internal

fmt-check:
	@test -z "$$(gofmt -l ./cmd ./internal)" || \
		{ gofmt -l ./cmd ./internal; exit 1; }

lint:
	go vet ./...

test:
	go test -p=1 ./...

test-postgres:
	@test -n "$$ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL" || \
		{ echo "ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL is required" >&2; exit 1; }
	go test -p=1 ./internal/repository/postgres -run TestRepository -count=1

e2e:
	$(MAKE) -C ../.. e2e-runtime-controller
