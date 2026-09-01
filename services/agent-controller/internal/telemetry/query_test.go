package telemetry

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestObservedAgentQueryStoreClassifiesMissingProjectionWithoutQueryDimensions(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	next := &agentQueryStoreTelemetryStub{err: ports.ErrNotFound}
	var logs bytes.Buffer
	observed, err := ObserveAgentQueryStore(next, slog.New(slog.NewTextHandler(&logs, nil)))
	if err != nil {
		t.Fatalf("observe Agent query store: %v", err)
	}
	_, _ = observed.GetAgent(context.Background(), "private-agent-id")

	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Name() != "agent_controller.repository.get_agent" ||
		ended[0].Status().Description != "not_found" {
		t.Fatalf("query span = %+v", ended)
	}
	attributes := fmt.Sprint(ended[0].Attributes())
	if strings.Contains(attributes, "private-agent-id") {
		t.Fatalf("query span leaked Agent identity: %s", attributes)
	}
	if strings.Contains(logs.String(), "private-agent-id") ||
		!strings.Contains(logs.String(), "operation=get_agent") ||
		!strings.Contains(logs.String(), "error_class=not_found") {
		t.Fatalf("query log fields = %s", logs.String())
	}
}

func TestObservedAgentQueryStoreDoesNotRecordFiltersOrCursor(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	observed, err := ObserveAgentQueryStore(
		&agentQueryStoreTelemetryStub{}, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
	)
	if err != nil {
		t.Fatalf("observe Agent query store: %v", err)
	}
	_, _ = observed.ListAgents(context.Background(), ports.AgentQuery{
		OrganizationID: "private-org", OwnerUserID: "private-owner",
		AfterCreatedAt: time.Unix(1, 0).UTC(), AfterAgentID: "private-cursor-agent", Limit: 10,
	})

	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Name() != "agent_controller.repository.list_agents" {
		t.Fatalf("query span = %+v", ended)
	}
	attributes := fmt.Sprint(ended[0].Attributes())
	for _, forbidden := range []string{"private-org", "private-owner", "private-cursor-agent"} {
		if strings.Contains(attributes, forbidden) {
			t.Fatalf("query span leaked %q: %s", forbidden, attributes)
		}
	}
}

func TestObservedAgentQueryStoreCorrelatesExactProjectionSequence(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	observed, err := ObserveAgentQueryStore(
		&agentQueryStoreTelemetryStub{record: ports.AgentRecord{AggregateSequence: 17}},
		slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
	)
	if err != nil {
		t.Fatalf("observe Agent query store: %v", err)
	}
	_, _ = observed.GetAgent(context.Background(), "agent-1")

	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("query span count = %d", len(ended))
	}
	found := false
	for _, value := range ended[0].Attributes() {
		if string(value.Key) == "antnest.agent.aggregate_sequence" && value.Value.AsInt64() == 17 {
			found = true
		}
	}
	if !found {
		t.Fatalf("query span lacks projection sequence: %+v", ended[0].Attributes())
	}
}

type agentQueryStoreTelemetryStub struct {
	record ports.AgentRecord
	err    error
}

func (store *agentQueryStoreTelemetryStub) GetAgent(
	context.Context, string,
) (ports.AgentRecord, error) {
	return store.record, store.err
}

func (store *agentQueryStoreTelemetryStub) ListAgents(
	context.Context, ports.AgentQuery,
) ([]ports.AgentRecord, error) {
	return nil, store.err
}
