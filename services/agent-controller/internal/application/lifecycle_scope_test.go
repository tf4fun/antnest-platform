package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestLifecycleMutationsRejectCrossOrganizationAgentBeforeAdmission(t *testing.T) {
	t.Parallel()

	t.Run("rebuild", func(t *testing.T) {
		template := mustLifecycleTemplate(t)
		model := mustLifecycleModel(t)
		base := rebuildLifecycleBase(t, template, model)
		store := &rebuildLifecycleStoreStub{base: base}
		dependencies := &rebuildDependenciesStub{}
		service := NewLifecycleService(
			lifecycleSpecSourceStub{}, store, dependencies, dependencies,
			fixedClock{now: time.Unix(1, 0).UTC()},
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
		base := deleteAgentBase(domain.AgentAvailable)
		store := &deleteLifecycleStoreStub{base: base}
		dependencies := newDeleteDependencies(base.Agent)
		service := NewLifecycleService(
			lifecycleSpecSourceStub{}, store, dependencies, dependencies,
			fixedClock{now: time.Unix(1, 0).UTC()},
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
