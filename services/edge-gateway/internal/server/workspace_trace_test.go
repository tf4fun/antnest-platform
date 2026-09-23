package server

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestWorkspaceRelayForwardsMessageTraceBeforeSocketCloses(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous, propagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		otel.SetTracerProvider(previous)
		otel.SetTextMapPropagator(propagator)
	})
	fixture := newRelayFixture(t, "v1")
	sendACPFrame(t, fixture.client, `{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s","prompt":[]}}`)
	payload := <-fixture.received
	var frame struct {
		Params struct {
			Meta map[string]string `json:"_meta"`
		} `json:"params"`
	}
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatal(err)
	}
	parent := trace.SpanContextFromContext(propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier(frame.Params.Meta)))
	if !parent.IsValid() {
		t.Fatal("ACP message lost Gateway context")
	}
	deadline := time.After(time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		for _, span := range recorder.Ended() {
			if span.SpanContext().SpanID() == parent.SpanID() && span.SpanContext().TraceID() == parent.TraceID() && span.SpanKind() == trace.SpanKindProducer && span.Name() == "acp session/prompt" {
				return
			}
		}
		select {
		case <-tick.C:
		case <-deadline:
			t.Fatal("forwarding span not exported while socket remains open")
		}
	}
}
