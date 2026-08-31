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
