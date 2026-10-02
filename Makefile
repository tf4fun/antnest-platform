.PHONY: fmt fmt-check lint go-lint rust-clippy node-lint test test-go test-rust test-node test-managed-mcp-fixtures test-postgres test-egress-postgres test-runtime-controller-postgres test-agent-acp-postgres test-identity-postgres test-agent-controller-postgres docker-build docker-build-runtime-controller docker-build-agent-ui docker-build-stage3 compose-up compose-down e2e-stage1 e2e-stage2 e2e-stage3 e2e-runtime-controller e2e-skill-learning-runtime e2e-skill-learning-automatic e2e-skill-learning-preempt e2e-skill-learning-policy-off e2e-skill-learning-lifecycle-disable e2e-skill-learning-lifecycle-rebuild e2e-skill-learning-ui-outage e2e-skill-learning-skip e2e-skill-learning-model-failure e2e-skill-learning-restart

GOCACHE := $(CURDIR)/.cache/go-build
GOMODCACHE := $(CURDIR)/.cache/go-mod
GOLANGCI_LINT_CACHE := $(CURDIR)/.cache/golangci-lint
POSTGRES_ADMIN_USER := antnest_test_admin


fmt:
	gofmt -w $$(find services tests -name '*.go' -type f)
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all
	npm --prefix services/agent-acp-service run format
	rustfmt --edition 2024 tests/integration/runtime-egress/*.rs tests/integration/antnest-runtime/*.rs
	services/agent-acp-service/node_modules/.bin/prettier --write 'tests/**/*.mjs' 'tests/**/*.ts'

fmt-check:
	@unformatted="$$(gofmt -l $$(find services tests -name '*.go' -type f))" || exit $$?; \
		test -z "$$unformatted"
	cargo fmt --manifest-path runtimes/antnest-runtime/Cargo.toml --all --check
	cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all --check
	npm --prefix services/agent-acp-service run format:check
	rustfmt --edition 2024 --check tests/integration/runtime-egress/*.rs tests/integration/antnest-runtime/*.rs
	services/agent-acp-service/node_modules/.bin/prettier --check 'tests/**/*.mjs' 'tests/**/*.ts'

lint: go-lint rust-clippy node-lint

go-lint:
	GOLANGCI_LINT_CACHE=$(GOLANGCI_LINT_CACHE) GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/support/go-lint.mjs

rust-clippy:
	cargo clippy --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --all-targets -- -D warnings
	cargo clippy --manifest-path services/runtime-egress/Cargo.toml --locked --all-targets -- -D warnings

node-lint:
	@find tests -name '*.mjs' -type f -exec node --check {} \;
	node --check tests/e2e/admin-console/shutdown-docker.mjs
	node --check tests/e2e/edge-gateway/shutdown-docker.mjs
	npm --prefix services/agent-acp-service run lint
	services/agent-acp-service/node_modules/.bin/eslint --config services/agent-acp-service/eslint.config.js tests/integration/agent-acp-service
	npm --prefix services/agent-acp-service run typecheck
	npm --prefix services/admin-console/web run typecheck
	npm --prefix services/agent-ui/web run typecheck

test: test-storage-policy
	$(MAKE) test-go
	$(MAKE) test-rust
	$(MAKE) test-node

.PHONY: test-storage-policy
test-storage-policy:
	node tests/support/check-storage.mjs
	python3 -B tests/support/verification/configuration_test.py

test-go:
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs runtime-controller
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs identity-service
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs agent-controller
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs admin-console
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs edge-gateway
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs skill-registry

.PHONY: test-go-unit
test-go-unit:
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/runtime-controller/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/identity-service/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/agent-controller/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/admin-console/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/edge-gateway/...
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) go test -p=1 ./services/skill-registry/...

test-rust:
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked
	cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --example managed-mcp-fixture
	cargo test --manifest-path services/runtime-egress/Cargo.toml --locked

.PHONY: test-verification-python
test-verification-python:
	python3 -B -m unittest discover -s tests/support/verification -p '*_test.py'

.PHONY: check-links
check-links:
	node tests/support/check-markdown-links.mjs

test-node: test-repo
	npm --prefix services/agent-acp-service test
	npm --prefix services/agent-acp-service run test:integration
	npm --prefix services/admin-console/web test
	npm --prefix services/agent-ui/web test

# Repository-level contract, tooling, and fixture suites. They need Node,
# Go, Python, and the agent-acp-service dependencies, but no Docker or databases.
.PHONY: test-repo
test-repo:
	$(MAKE) test-verification-python
	node --test --test-concurrency=1 tests/support/*.test.mjs tests/support/verification/*.test.mjs
	node --test --test-concurrency=1 tests/integration/skill-learning/contracts.test.mjs tests/integration/skill-learning/maintenance-runtime-spec.test.mjs
	node --test --test-concurrency=1 tests/integration/skill-registry/discovery-contract.test.mjs
	node --test --test-concurrency=1 tests/integration/runtime-tools/contracts.test.mjs
	node --test --test-concurrency=1 tests/e2e/skill-learning/tool-usability-model.test.mjs tests/e2e/skill-learning/maintenance-kid.test.mjs
	node --test tests/integration/deployment/deployment.test.mjs
	node --test --test-concurrency=1 tests/integration/development/*.test.mjs
	node --test --test-concurrency=1 tests/integration/deployment/temporal/*.test.mjs
	node --test tests/e2e/observability/*.test.mjs
	node --test --test-concurrency=1 tests/e2e/agent-acp-service/stage2-*.test.mjs
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
	node --test --test-concurrency=1 tests/e2e/acp-closeout/*.test.mjs
	node --test --test-concurrency=1 tests/e2e/identity-closeout/*.test.mjs

test-managed-mcp-fixtures:
	node --test --test-concurrency=1 tests/e2e/managed-mcp/*.test.mjs

.PHONY: test-rpc-response-loss-fixtures
test-rpc-response-loss-fixtures:
	node --test --test-concurrency=1 tests/e2e/rpc-response-loss/*.test.mjs

.PHONY: test-lifecycle-fixtures e2e-lifecycle
test-lifecycle-fixtures:
	node --test --test-concurrency=1 tests/e2e/lifecycle-closeout/*.test.mjs

e2e-lifecycle:
	node tests/e2e/lifecycle-closeout/run.mjs

.PHONY: e2e-lifecycle-shutdown
e2e-lifecycle-shutdown:
	node tests/e2e/lifecycle-closeout/run.mjs shutdown

.PHONY: e2e-lifecycle-health
e2e-lifecycle-health:
	node tests/e2e/lifecycle-closeout/run.mjs health

.PHONY: e2e-lifecycle-restore
e2e-lifecycle-restore:
	node tests/e2e/lifecycle-closeout/run.mjs restore

.PHONY: e2e-stage4-skill-storage-restore
e2e-stage4-skill-storage-restore:
	node tests/e2e/lifecycle-closeout/restore-stage4-storage-docker.mjs

.PHONY: e2e-stage4-skill-restore
e2e-stage4-skill-restore:
	node tests/e2e/lifecycle-closeout/run.mjs skill-restore

.PHONY: test-workspace-fixtures e2e-workspace
test-workspace-fixtures:
	node --test --test-concurrency=1 tests/e2e/workspace-closeout/*.test.mjs

e2e-workspace:
	node tests/e2e/workspace-closeout/run.mjs

.PHONY: e2e-workspace-browser
e2e-workspace-browser:
	node tests/e2e/workspace-closeout/browser-run.mjs

.PHONY: e2e-lifecycle-interrupted
e2e-lifecycle-interrupted:
	node tests/e2e/lifecycle-closeout/interrupted-run.mjs

.PHONY: e2e-lifecycle-network
e2e-lifecycle-network:
	node tests/e2e/lifecycle-closeout/run.mjs network

.PHONY: e2e-lifecycle-loss
e2e-lifecycle-loss:
	node tests/e2e/lifecycle-closeout/run.mjs loss

.PHONY: e2e-rpc-response-loss
e2e-rpc-response-loss:
	ANTNEST_E2E_RPC_RESPONSE_LOSS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-tool-progress-fixtures e2e-tool-progress
test-tool-progress-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-progress/*.test.mjs

e2e-tool-progress:
	ANTNEST_E2E_TOOL_PROGRESS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-file-observation-fixtures e2e-file-observations
test-file-observation-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-files/*.test.mjs

e2e-file-observations:
	ANTNEST_E2E_FILE_OBSERVATIONS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-plan-fixtures e2e-structured-plan
test-plan-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-plan/*.test.mjs

e2e-structured-plan:
	ANTNEST_E2E_STRUCTURED_PLAN=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-permission-fixtures e2e-tool-permissions
test-permission-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-permissions/*.test.mjs

e2e-tool-permissions:
	ANTNEST_E2E_TOOL_PERMISSIONS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-command-fixtures e2e-slash-commands
test-command-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-commands/*.test.mjs

e2e-slash-commands:
	ANTNEST_E2E_SLASH_COMMANDS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-multimodal-fixtures e2e-multimodal
test-multimodal-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-multimodal/*.test.mjs

e2e-multimodal:
	ANTNEST_E2E_MULTIMODAL=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-cost-fixtures e2e-session-cost
test-cost-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-cost/*.test.mjs

e2e-session-cost:
	ANTNEST_E2E_SESSION_COST=true sh tests/e2e/e2e-stage3a.sh

test-postgres:
	node tests/support/dependencies.mjs --profile temporal --name postgres-$$(date +%s)-$$$$ -- sh tests/integration/test-postgres.sh

test-egress-postgres:
	node tests/support/dependencies.mjs --name egress-$$(date +%s)-$$$$ -- cargo test --manifest-path services/runtime-egress/Cargo.toml --locked --lib --test postgres_repository -- --ignored --test-threads=1

test-runtime-controller-postgres:
	node tests/support/dependencies.mjs --name runtime-controller-$$(date +%s)-$$$$ -- node tests/support/verification/go-service.mjs runtime-controller

test-agent-acp-postgres:
	node tests/support/dependencies.mjs --name acp-$$(date +%s)-$$$$ -- npm --prefix services/agent-acp-service run test:postgres

test-identity-postgres:
	node tests/support/dependencies.mjs --name identity-$$(date +%s)-$$$$ -- node tests/support/verification/go-service.mjs identity-service

test-agent-controller-postgres:
	node tests/support/dependencies.mjs --profile temporal --name agent-controller-$$(date +%s)-$$$$ -- node tests/support/verification/go-service.mjs agent-controller

docker-build-runtime-controller:
	docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
	docker compose build runtime-egress
	docker compose build runtime-controller

e2e-skill-learning-runtime:
	docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:skill-learning-build .
	docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:skill-learning-local .
	node tests/e2e/skill-learning/runtime-prepare.mjs

e2e-skill-learning-automatic:
	node --test tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-runtime-tool-usability
e2e-runtime-tool-usability:
	docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
	ANTNEST_E2E_SKILL_LEARNING_DEBUG=true ANTNEST_E2E_TOOL_USABILITY=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-learning-trace
e2e-skill-learning-trace:
	ANTNEST_E2E_LEARNING_TRACE=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

e2e-skill-learning-cleanup:
	ANTNEST_E2E_SKILL_CLEANUP=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-learning-cleanup e2e-skill-learning-cleanup-lost-response

e2e-skill-learning-cleanup-lost-response:
	ANTNEST_E2E_SKILL_CLEANUP_LOST_RESPONSE=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

e2e-skill-learning-preempt:
	node --test tests/e2e/skill-learning/preempt-flow.test.mjs

e2e-skill-learning-policy-off:
	ANTNEST_E2E_POLICY_OFF=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

e2e-skill-learning-lifecycle-disable:
	ANTNEST_E2E_LIFECYCLE_DISABLE=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

e2e-skill-learning-lifecycle-rebuild:
	ANTNEST_E2E_LIFECYCLE_REBUILD=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

.PHONY: e2e-skill-learning-held-commit-disable
e2e-skill-learning-held-commit-disable:
	node --test tests/e2e/skill-learning/held-commit-lifecycle.test.mjs

.PHONY: e2e-skill-learning-held-commit-foreground
e2e-skill-learning-held-commit-foreground:
	ANTNEST_E2E_FOREGROUND_DURING_COMMIT=true node --test tests/e2e/skill-learning/held-commit-lifecycle.test.mjs

.PHONY: e2e-skill-learning-atomic-commit-foreground
e2e-skill-learning-atomic-commit-foreground:
	ANTNEST_E2E_FOREGROUND_DURING_ATOMIC_COMMIT=true node --test tests/e2e/skill-learning/held-commit-lifecycle.test.mjs

.PHONY: e2e-skill-learning-lost-commit-disable
e2e-skill-learning-lost-commit-disable:
	ANTNEST_E2E_DROP_COMMIT_RESPONSE=true node --test tests/e2e/skill-learning/held-commit-lifecycle.test.mjs

.PHONY: e2e-skill-learning-pre-dispatch-disable
e2e-skill-learning-pre-dispatch-disable:
	ANTNEST_E2E_HOLD_BEFORE_COMMIT=true node --test tests/e2e/skill-learning/held-commit-lifecycle.test.mjs

.PHONY: e2e-skill-learning-atomic-commit-disable
e2e-skill-learning-atomic-commit-disable:
	ANTNEST_E2E_HOLD_AFTER_INSTALL=true node --test tests/e2e/skill-learning/held-commit-lifecycle.test.mjs

.PHONY: e2e-skill-learning-notice-send-failure
e2e-skill-learning-notice-send-failure:
	ANTNEST_E2E_NOTICE_SEND_FAILURE=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-learning-key-compromise
e2e-skill-learning-key-compromise:
	ANTNEST_E2E_SKILL_KEY_COMPROMISE=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-learning-key-rotation
e2e-skill-learning-key-rotation:
	ANTNEST_E2E_SKILL_KEY_ROTATION=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-learning-pinned
e2e-skill-learning-pinned:
	ANTNEST_E2E_SKILL_PINNED=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-learning-untrusted-only
e2e-skill-learning-untrusted-only:
	ANTNEST_E2E_REVIEW_UNTRUSTED=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

e2e-skill-learning-ui-outage:
	ANTNEST_E2E_UI_OUTAGE=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

e2e-skill-learning-skip:
	ANTNEST_E2E_REVIEW_SKIP=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

.PHONY: e2e-skill-learning-debug
e2e-skill-learning-debug:
	ANTNEST_E2E_SKILL_LEARNING_DEBUG=true ANTNEST_E2E_LEARNING_TRACE=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

e2e-skill-learning-model-failure:
	ANTNEST_E2E_REVIEW_FAILURE=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

.PHONY: e2e-skill-learning-model-recovery
e2e-skill-learning-model-recovery:
	ANTNEST_E2E_REVIEW_RECOVERY=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

.PHONY: e2e-skill-learning-browser e2e-skill-learning-diagnostics-browser
e2e-skill-learning-browser:
	ANTNEST_E2E_SKILL_BROWSER=true node --test tests/e2e/skill-learning/automatic-flow.test.mjs

e2e-skill-learning-diagnostics-browser:
	ANTNEST_E2E_SKILL_BROWSER=true ANTNEST_E2E_REVIEW_RECOVERY=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

e2e-skill-learning-restart:
	ANTNEST_E2E_REVIEW_RESTART=true node --test tests/e2e/skill-learning/preempt-flow.test.mjs

docker-build: docker-build-runtime-controller
	docker compose --profile stage2 build temporal
	docker compose build agent-acp-service
	docker compose --profile stage2 build identity-service
	docker compose --profile stage2 build agent-controller

docker-build-agent-ui:
	docker build -f services/agent-ui/Dockerfile -t antnest/agent-ui:local .

docker-build-stage3: docker-build-runtime-controller
	docker compose --profile stage3 build temporal
	docker compose --profile stage3 build agent-acp-service
	docker compose --profile stage3 build identity-service
	docker compose --profile stage3 build agent-controller
	docker compose --profile stage3 build skill-registry
	docker compose --profile stage3 build admin-console
	docker compose --profile stage3 build agent-ui
	docker compose --profile stage3 build edge-gateway

compose-up: docker-build-runtime-controller
	docker compose up -d --wait postgres runtime-egress runtime-controller

compose-down:
	docker compose down --remove-orphans

e2e-stage1: docker-build-runtime-controller
	sh tests/e2e/e2e-stage1.sh

e2e-stage2: docker-build
	sh tests/e2e/e2e-stage2.sh

e2e-stage3: docker-build-stage3
	sh tests/e2e/e2e-stage3a.sh

.PHONY: test-stage3-base-fixtures e2e-stage3-local e2e-stage3-skill-delivery
test-stage3-base-fixtures:
	node --test --test-concurrency=1 tests/e2e/stage3-base/*.test.mjs

e2e-stage3-local:
	sh tests/e2e/e2e-stage3a.sh

e2e-stage3-skill-delivery:
	ANTNEST_E2E_SKILL_DELIVERY=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-ready-loss
e2e-stage4-skill-ready-loss:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_READY_LOSS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: integration-stage4-skill-prepare integration-stage4-skill-slow-prepare integration-stage4-skill-restart-prepare
integration-stage4-skill-prepare:
	bash tests/integration/skill-registry/run-registry-rc-prepare.sh

integration-stage4-skill-slow-prepare:
	ANTNEST_TEST_SLOW_SKILL_PREPARATION=true bash tests/integration/skill-registry/run-registry-rc-prepare.sh

integration-stage4-skill-restart-prepare:
	ANTNEST_TEST_SLOW_SKILL_PREPARATION=true ANTNEST_TEST_RESTART_SKILL_PREPARATION=true bash tests/integration/skill-registry/run-registry-rc-prepare.sh

.PHONY: e2e-stage4-skill-ready-drift
e2e-stage4-skill-ready-drift:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_READY_DRIFT=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-target-drift
e2e-stage4-skill-target-drift:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_TARGET_DRIFT=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-skill-discovery-registry
e2e-skill-discovery-registry:
	node tests/e2e/skill-registry/discovery-docker.mjs

.PHONY: e2e-skill-discovery-acp
e2e-skill-discovery-acp:
	ANTNEST_E2E_SKILL_DISCOVERY=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-discovery-tools
e2e-skill-discovery-tools:
	ANTNEST_E2E_SKILL_DISCOVERY=true ANTNEST_E2E_SKILL_DISCOVERY_TOOLS=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-temporary-runtime
e2e-skill-temporary-runtime:
	node tests/e2e/skill-registry/temporary-runtime.mjs --build

.PHONY: e2e-skill-temporary-acp
e2e-skill-temporary-acp:
	ANTNEST_E2E_SKILL_DISCOVERY=true ANTNEST_E2E_SKILL_DISCOVERY_TOOLS=true ANTNEST_E2E_SKILL_TEMPORARY=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-discovery-console
e2e-skill-discovery-console:
	node tests/e2e/skill-registry/console-discovery.mjs

.PHONY: e2e-skill-propagation
e2e-skill-propagation:
	ANTNEST_E2E_SKILL_DISCOVERY=true ANTNEST_E2E_SKILL_DISCOVERY_TOOLS=true ANTNEST_E2E_SKILL_TEMPORARY=true ANTNEST_E2E_SKILL_PROPAGATION=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: test-skill-deployment e2e-skill-deployment
test-skill-deployment:
	node --test --test-concurrency=1 tests/integration/skill-registry/deployment-config.test.mjs

e2e-skill-deployment:
	ANTNEST_E2E_SKILL_DISCOVERY=true ANTNEST_E2E_SKILL_DISCOVERY_TOOLS=true ANTNEST_E2E_SKILL_TEMPORARY=true ANTNEST_E2E_SKILL_PROPAGATION=true ANTNEST_E2E_SKILL_DEPLOYMENT=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-source-lifecycle
e2e-skill-source-lifecycle:
	ANTNEST_E2E_SKILL_DISCOVERY=true ANTNEST_E2E_SKILL_DISCOVERY_TOOLS=true ANTNEST_E2E_SKILL_TEMPORARY=true ANTNEST_E2E_SKILL_PROPAGATION=true ANTNEST_E2E_SKILL_DEPLOYMENT=true ANTNEST_E2E_SKILL_SOURCE_LIFECYCLE=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-discovery-caller
e2e-skill-discovery-caller:
	ANTNEST_E2E_SKILL_DISCOVERY=true ANTNEST_E2E_SKILL_DISCOVERY_TOOLS=true ANTNEST_E2E_SKILL_TEMPORARY=true ANTNEST_E2E_SKILL_PROPAGATION=true ANTNEST_E2E_SKILL_DEPLOYMENT=true ANTNEST_E2E_SKILL_CALLER=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs

.PHONY: e2e-skill-discovery-caller-registry
e2e-skill-discovery-caller-registry:
	ANTNEST_E2E_DISCOVERY_CALLER=true node tests/e2e/skill-registry/discovery-docker.mjs

.PHONY: e2e-skill-registry-trace
e2e-skill-registry-trace:
	ANTNEST_E2E_DISCOVERY_CALLER=true ANTNEST_E2E_REGISTRY_TRACE=true node tests/e2e/skill-registry/discovery-docker.mjs

.PHONY: e2e-stage4-skill-registry-outage
e2e-stage4-skill-registry-outage:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_REGISTRY_OUTAGE=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-offline-reuse
e2e-stage4-skill-offline-reuse:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_OFFLINE_REUSE=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-mount-race
e2e-stage4-skill-mount-race:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_MOUNT_RACE=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-initialize-race
e2e-stage4-skill-initialize-race:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_INITIALIZE_RACE=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-mount-response-loss
e2e-stage4-skill-mount-response-loss:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_MOUNT_RACE=true ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-start-response-loss
e2e-stage4-skill-start-response-loss:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_START_RESPONSE_LOSS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-fenced-invalidation
e2e-stage4-skill-fenced-invalidation:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_FENCED_INVALIDATION=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-stage4-skill-restart-rebuild
e2e-stage4-skill-restart-rebuild:
	ANTNEST_E2E_SKILL_DELIVERY=true ANTNEST_E2E_SKILL_RESTART_REBUILD=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-identity-access e2e-identity-core
e2e-identity-core:
	ANTNEST_E2E_IDENTITY_CORE=true sh tests/e2e/e2e-stage3a.sh

e2e-identity-access:
	ANTNEST_E2E_IDENTITY_ACCESS=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-acp-session
e2e-acp-session:
	ANTNEST_E2E_ACP_SESSION=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-acp-closeout
e2e-acp-closeout:
	ANTNEST_E2E_ACP_CLOSEOUT=true sh tests/e2e/e2e-stage3a.sh

.PHONY: e2e-agent-access
e2e-agent-access:
	ANTNEST_E2E_AGENT_ACCESS=true sh tests/e2e/e2e-stage3a.sh

e2e-runtime-controller: docker-build-runtime-controller
	sh tests/e2e/runtime-controller/run.sh

.PHONY: e2e-managed-mcp-v1 e2e-managed-mcp-v2
e2e-managed-mcp-v1:
	ANTNEST_E2E_MANAGED_MCP=true ANTNEST_E2E_MANAGED_MCP_VERSION=1 sh tests/e2e/e2e-stage3a.sh

e2e-managed-mcp-v2:
	ANTNEST_E2E_MANAGED_MCP=true ANTNEST_E2E_MANAGED_MCP_VERSION=2 sh tests/e2e/e2e-stage3a.sh

.PHONY: test-acp-persistence-fixtures e2e-acp-persistence
test-acp-persistence-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-persistence/*.test.mjs

e2e-acp-persistence:
	ANTNEST_E2E_ACP_PERSISTENCE=true sh tests/e2e/e2e-stage3a.sh

.PHONY: test-acp-restart-fixtures e2e-acp-restart
test-acp-restart-fixtures:
	node --test --test-concurrency=1 tests/e2e/acp-restart/*.test.mjs

e2e-acp-restart:
	ANTNEST_E2E_ACP_RESTART=true sh tests/e2e/e2e-stage3a.sh

# Explicit abnormal-exit diagnostic; excluded from stable lifecycle targets.
.PHONY: e2e-lifecycle-crash
e2e-lifecycle-crash:
	node tests/e2e/lifecycle-closeout/crash-run.mjs

.PHONY: test-integration test-integration-go test-integration-node
test-integration:
	$(MAKE) test-integration-go
	$(MAKE) test-integration-rust
	$(MAKE) test-integration-node

test-integration-go:
	$(MAKE) test-runtime-controller-postgres
	$(MAKE) test-identity-postgres
	$(MAKE) test-agent-controller-postgres
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs admin-console -- -race
	GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) node tests/integration/go/run.mjs edge-gateway -- -race

test-integration-node:
	npm --prefix services/agent-acp-service run test:integration
	$(MAKE) test-agent-acp-postgres
	$(MAKE) test-agent-acp-audit
	npm --prefix services/admin-console/web run test:browser:catalog
	npm --prefix services/admin-console/web run test:browser:audit
	npm --prefix services/admin-console/web run test:browser:skills
	npm --prefix services/admin-console/web run test:browser:template-skills
	npm --prefix services/agent-ui/web run test:browser

.PHONY: test-agent-acp-audit
test-agent-acp-audit:
	node tests/support/dependencies.mjs --name acp-audit-$$(date +%s)-$$$$ -- npm --prefix services/agent-acp-service run test:audit:v1

.PHONY: test-integration-rust
test-integration-rust:
	$(MAKE) test-rust
	$(MAKE) test-egress-postgres
	cargo test --locked --manifest-path tests/integration/antnest-runtime/sdk-probes/elicitation/Cargo.toml
