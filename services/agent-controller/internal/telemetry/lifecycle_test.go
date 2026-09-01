package telemetry

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestObservedLifecycleStoreEmitsBoundedOperationSpan(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	next := &lifecycleStoreStub{err: errors.New("provider-secret=top-secret")}
	observed, err := ObserveLifecycleStore(next, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("observe lifecycle store: %v", err)
	}
	if _, _, err := observed.ReplayAgentCreate(context.Background(), "request-1", "fingerprint"); err == nil {
		t.Fatal("repository error was swallowed")
	}
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Name() != "agent_controller.repository.replay_agent_create" {
		t.Fatalf("repository spans = %#v", ended)
	}
	if ended[0].Status().Code != codes.Error || ended[0].Status().Description != "persistence_error" {
		t.Fatalf("repository span status = %+v", ended[0].Status())
	}
	if len(ended[0].Events()) != 0 {
		t.Fatalf("repository span recorded raw error events: %+v", ended[0].Events())
	}
}

func TestObservedEnableAdvanceRecordsPhaseTransition(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	observed, err := ObserveLifecycleStore(
		&lifecycleStoreStub{}, slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatalf("observe lifecycle store: %v", err)
	}
	_, err = observed.AdvanceAgentEnable(context.Background(), ports.AdvanceAgentEnable{
		ExpectedPhase: domain.PhaseRuntimeEnable, NextPhase: domain.PhaseNetworkRestore,
	})
	if err != nil {
		t.Fatalf("advance enable operation: %v", err)
	}
	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("repository spans = %#v", ended)
	}
	attributes := make(map[string]string, len(ended[0].Attributes()))
	for _, item := range ended[0].Attributes() {
		attributes[string(item.Key)] = item.Value.AsString()
	}
	if attributes["antnest.lifecycle.expected_phase"] != string(domain.PhaseRuntimeEnable) ||
		attributes["antnest.lifecycle.next_phase"] != string(domain.PhaseNetworkRestore) {
		t.Fatalf("phase attributes = %+v", attributes)
	}
}

type lifecycleStoreStub struct{ err error }

func (store *lifecycleStoreStub) GetLifecycleOperation(
	context.Context, string,
) (ports.LifecycleOperationRecord, error) {
	return ports.LifecycleOperationRecord{}, store.err
}

func (store *lifecycleStoreStub) GetAgentLifecycleBase(
	context.Context, string,
) (ports.AgentLifecycleBase, error) {
	return ports.AgentLifecycleBase{}, store.err
}

func (store *lifecycleStoreStub) ReplayAgentCreate(
	context.Context, string, string,
) (ports.AgentCreateState, bool, error) {
	return ports.AgentCreateState{}, false, store.err
}

func (store *lifecycleStoreStub) BeginAgentCreate(
	context.Context, ports.BeginAgentCreate,
) (ports.AgentCreateState, bool, error) {
	return ports.AgentCreateState{}, false, store.err
}

func (store *lifecycleStoreStub) RecordCreateNetwork(
	context.Context, string, string, ports.NetworkAttachment, string, time.Time,
) (ports.AgentCreateState, error) {
	return ports.AgentCreateState{}, store.err
}

func (store *lifecycleStoreStub) RecordCreateRuntime(
	context.Context, string, string, ports.RuntimeOperation, string, time.Time,
) (ports.AgentCreateState, error) {
	return ports.AgentCreateState{}, store.err
}

func (store *lifecycleStoreStub) PublishAgentCreate(
	context.Context, ports.PublishAgentCreate,
) (ports.AgentCreateState, error) {
	return ports.AgentCreateState{}, store.err
}

func (store *lifecycleStoreStub) FailAgentCreate(
	context.Context, ports.FailAgentCreate,
) (ports.AgentCreateState, error) {
	return ports.AgentCreateState{}, store.err
}

func (store *lifecycleStoreStub) ReplayAgentRebuild(
	context.Context, string, string,
) (ports.AgentRebuildState, bool, error) {
	return ports.AgentRebuildState{}, false, store.err
}

func (store *lifecycleStoreStub) BeginAgentRebuild(
	context.Context, ports.BeginAgentRebuild,
) (ports.AgentRebuildState, bool, error) {
	return ports.AgentRebuildState{}, false, store.err
}

func (store *lifecycleStoreStub) RecordAgentRebuildPolicy(
	context.Context, string, string, ports.NetworkPolicyAssignment, time.Time,
) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, store.err
}

func (store *lifecycleStoreStub) SettleAgentRebuildDrain(
	context.Context, string, string, string, time.Time,
) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, store.err
}

func (store *lifecycleStoreStub) AdvanceAgentRebuild(
	context.Context, ports.AdvanceAgentRebuild,
) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, store.err
}

func (store *lifecycleStoreStub) PublishAgentRebuild(
	context.Context, ports.PublishAgentRebuild,
) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, store.err
}

func (store *lifecycleStoreStub) FailAgentRebuild(
	context.Context, ports.FailAgentRebuild,
) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, store.err
}

func (store *lifecycleStoreStub) ReplayAgentDisable(
	context.Context, string, string,
) (ports.AgentDisableState, bool, error) {
	return ports.AgentDisableState{}, false, store.err
}

func (store *lifecycleStoreStub) BeginAgentDisable(
	context.Context, ports.BeginAgentDisable,
) (ports.AgentDisableState, bool, error) {
	return ports.AgentDisableState{}, false, store.err
}

func (store *lifecycleStoreStub) RecordAgentDisablePolicy(
	context.Context, string, string, ports.NetworkPolicyAssignment, time.Time,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, store.err
}

func (store *lifecycleStoreStub) SettleAgentDisableDrain(
	context.Context, string, string, string, time.Time,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, store.err
}

func (store *lifecycleStoreStub) AdvanceAgentDisable(
	context.Context, ports.AdvanceAgentDisable,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, store.err
}

func (store *lifecycleStoreStub) PublishAgentDisable(
	context.Context, ports.PublishAgentDisable,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, store.err
}

func (store *lifecycleStoreStub) FailAgentDisable(
	context.Context, ports.FailAgentDisable,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, store.err
}

func (store *lifecycleStoreStub) GetAgentEnableBase(
	context.Context, string,
) (ports.AgentEnableBase, error) {
	return ports.AgentEnableBase{}, store.err
}

func (store *lifecycleStoreStub) ReplayAgentEnable(
	context.Context, string, string,
) (ports.AgentEnableState, bool, error) {
	return ports.AgentEnableState{}, false, store.err
}

func (store *lifecycleStoreStub) BeginAgentEnable(
	context.Context, ports.BeginAgentEnable,
) (ports.AgentEnableState, bool, error) {
	return ports.AgentEnableState{}, false, store.err
}

func (store *lifecycleStoreStub) AdvanceAgentEnable(
	context.Context, ports.AdvanceAgentEnable,
) (ports.AgentEnableState, error) {
	return ports.AgentEnableState{}, store.err
}

func (store *lifecycleStoreStub) PublishAgentEnable(
	context.Context, ports.PublishAgentEnable,
) (ports.AgentEnableState, error) {
	return ports.AgentEnableState{}, store.err
}

func (store *lifecycleStoreStub) FailAgentEnable(
	context.Context, ports.FailAgentEnable,
) (ports.AgentEnableState, error) {
	return ports.AgentEnableState{}, store.err
}

func (store *lifecycleStoreStub) GetAgentDeleteBase(
	context.Context, string,
) (ports.AgentDeleteBase, error) {
	return ports.AgentDeleteBase{}, store.err
}

func (store *lifecycleStoreStub) ReplayAgentDelete(
	context.Context, string, string,
) (ports.AgentDeleteState, bool, error) {
	return ports.AgentDeleteState{}, false, store.err
}

func (store *lifecycleStoreStub) BeginAgentDelete(
	context.Context, ports.BeginAgentDelete,
) (ports.AgentDeleteState, bool, error) {
	return ports.AgentDeleteState{}, false, store.err
}

func (store *lifecycleStoreStub) SettleAgentDeleteDrain(
	context.Context, string, string, string, time.Time,
) (ports.AgentDeleteState, error) {
	return ports.AgentDeleteState{}, store.err
}

func (store *lifecycleStoreStub) AdvanceAgentDelete(
	context.Context, ports.AdvanceAgentDelete,
) (ports.AgentDeleteState, error) {
	return ports.AgentDeleteState{}, store.err
}

func (store *lifecycleStoreStub) PublishAgentDelete(
	context.Context, ports.PublishAgentDelete,
) (ports.AgentDeleteState, error) {
	return ports.AgentDeleteState{}, store.err
}
