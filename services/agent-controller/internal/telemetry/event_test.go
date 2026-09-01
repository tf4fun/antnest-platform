package telemetry

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestObservedAgentEventStoreDoesNotRecordAgentOrCursor(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	observed, err := ObserveAgentEventStore(
		&agentEventStoreTelemetryStub{records: []ports.AgentEventRecord{{EventID: "event-1"}}},
		slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
	)
	if err != nil {
		t.Fatalf("observe Agent event store: %v", err)
	}
	_, _ = observed.ListAgentEvents(context.Background(), ports.AgentEventQuery{
		AgentID: "private-agent", AfterSequence: 987654, Limit: 25,
	})

	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Name() != "agent_controller.repository.list_agent_events" {
		t.Fatalf("event span = %+v", ended)
	}
	attributes := fmt.Sprint(ended[0].Attributes())
	for _, forbidden := range []string{"private-agent", "987654"} {
		if strings.Contains(attributes, forbidden) {
			t.Fatalf("event span leaked %q: %s", forbidden, attributes)
		}
	}
}

type agentEventStoreTelemetryStub struct {
	records []ports.AgentEventRecord
	err     error
}

func (store *agentEventStoreTelemetryStub) ListAgentEvents(
	context.Context, ports.AgentEventQuery,
) ([]ports.AgentEventRecord, error) {
	return store.records, store.err
}
