package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleMutationsRejectCrossOrganizationAgentBeforeAdmission(t *testing.T) {
	t.Parallel()
	assertCrossOrganizationLifecycleDenied(t, func(*ports.AgentRecord) {})
}

func TestLifecycleScopeIsCheckedBeforeSourceState(t *testing.T) {
	t.Parallel()
	for _, state := range []domain.AgentState{
		domain.AgentNotCreated, domain.AgentCreated, domain.AgentDeleted,
	} {
		t.Run(string(state), func(t *testing.T) {
			assertCrossOrganizationLifecycleDenied(t, func(agent *ports.AgentRecord) {
				agent.LifecycleState = state
			})
		})
	}
	t.Run("active_operation", func(t *testing.T) {
		assertCrossOrganizationLifecycleDenied(t, func(agent *ports.AgentRecord) {
			agent.ActiveOperationRequestID = "foreign-active-operation"
		})
	})
}

func assertCrossOrganizationLifecycleDenied(t *testing.T, mutate func(*ports.AgentRecord)) {
	t.Helper()

	t.Run("rebuild", func(t *testing.T) {
		template := mustLifecycleTemplate(t)
		model := mustLifecycleModel(t)
		base := rebuildLifecycleBase(t, template, model)
		mutate(&base.Agent)
		store := &rebuildLifecycleStoreStub{base: base}
		dependencies := &rebuildDependenciesStub{}
		service := newTestLifecycleService(
			lifecycleSpecSourceStub{}, store, dependencies, dependencies,
			fixedClock{now: time.Unix(1, 0).UTC()},
			WithLifecycleExecution(testExecutionForStore(store)),
		)

		_, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
			RequestID: "request-cross-org-rebuild", OrganizationID: "org-2",
			ActorPrincipalID: "admin-2", AgentID: base.Agent.AgentID,
			TemplateID: "template-1", TemplateRevision: 1,
		})
		if !errors.Is(err, ErrAgentNotFound) || store.replayed || len(dependencies.calls) != 0 {
			t.Fatalf("cross-organization rebuild error=%v admitted=%v calls=%v", err, store.replayed, dependencies.calls)
		}
	})

	t.Run("disable", func(t *testing.T) {
		base := disableLifecycleBase(t)
		mutate(&base.Agent)
		store := &disableLifecycleStoreStub{base: base}
		dependencies := newDisableDependencies(base, readyEnableRuntime())
		service := newLifecycleTestService(t, store, dependencies)
		_, err := service.DisableAgent(context.Background(), DisableAgentInput{
			RequestID: "request-cross-org-disable", OrganizationID: "org-2",
			ActorPrincipalID: "admin-2", AgentID: base.Agent.AgentID,
		})
		if !errors.Is(err, ErrAgentNotFound) || store.replayed || len(dependencies.calls) != 0 {
			t.Fatalf("cross-organization disable error=%v admitted=%v calls=%v", err, store.replayed, dependencies.calls)
		}
	})

	t.Run("enable", func(t *testing.T) {
		base := enableLifecycleBase(t)
		mutate(&base.Agent)
		store := &enableLifecycleStoreStub{base: base}
		dependencies := newEnableDependencies(base, readyEnableRuntime())
		service := newLifecycleTestService(t, store, dependencies)
		_, err := service.EnableAgent(context.Background(), EnableAgentInput{
			RequestID: "request-cross-org-enable", OrganizationID: "org-2",
			ActorPrincipalID: "admin-2", AgentID: base.Agent.AgentID,
		})
		if !errors.Is(err, ErrAgentNotFound) || store.replayed || len(dependencies.calls) != 0 {
			t.Fatalf("cross-organization enable error=%v admitted=%v calls=%v", err, store.replayed, dependencies.calls)
		}
	})

	t.Run("delete", func(t *testing.T) {
		base := deleteAgentBase(domain.RuntimeAvailable)
		mutate(&base.Agent)
		store := &deleteLifecycleStoreStub{base: base}
		dependencies := newDeleteDependencies(base.Agent)
		service := newTestLifecycleService(
			lifecycleSpecSourceStub{}, store, dependencies, dependencies,
			fixedClock{now: time.Unix(1, 0).UTC()},
			WithLifecycleExecution(testExecutionForStore(store)),
		)

		_, err := service.DeleteAgent(context.Background(), DeleteAgentInput{
			RequestID: "request-cross-org-delete", OrganizationID: "org-2",
			ActorPrincipalID: "admin-2", AgentID: base.Agent.AgentID,
		})
		if !errors.Is(err, ErrAgentNotFound) || store.replayed || len(dependencies.calls) != 0 {
			t.Fatalf("cross-organization delete error=%v admitted=%v calls=%v", err, store.replayed, dependencies.calls)
		}
	})
}
