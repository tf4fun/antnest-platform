package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/gorilla/websocket"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func TestACPMessageLinksConnectionAndForwardsExactProducerParent(t *testing.T) {
	recorder := recordHTTPSpans(t)
	ctx, connection := otel.Tracer("test").Start(context.Background(), "connection")
	defer connection.End()
	const payload = `{"jsonrpc":"2.0","id":9007199254740993,"method":"session/prompt","params":{"sessionId":"session-1","prompt":[{"type":"text","text":"private-canary"}],"_meta":{"traceparent":"forged","tracestate":"forged","extension":{"number":9007199254740993}}}}`
	for range 2 {
		err := RelayACPMessage(ctx, websocket.TextMessage, []byte(payload), func(ctx context.Context) error {
			_, span := otel.Tracer("test").Start(ctx, "identity")
			span.End()
			return nil
		}, func(message []byte) error {
			var frame struct {
				ID     json.RawMessage `json:"id"`
				Params struct {
					Meta   map[string]json.RawMessage `json:"_meta"`
					Prompt json.RawMessage            `json:"prompt"`
				} `json:"params"`
			}
			if err := json.Unmarshal(message, &frame); err != nil {
				return err
			}
			if string(frame.ID) != "9007199254740993" || string(frame.Params.Meta["extension"]) != `{"number":9007199254740993}` || string(frame.Params.Prompt) != `[{"type":"text","text":"private-canary"}]` {
				t.Fatal("changed protocol data")
			}
			if _, ok := frame.Params.Meta["tracestate"]; ok {
				t.Fatal("forwarded forged tracestate")
			}
			var parent string
			if err := json.Unmarshal(frame.Params.Meta["traceparent"], &parent); err != nil {
				return err
			}
			extracted := otel.GetTextMapPropagator().Extract(context.Background(), propagation.MapCarrier{"traceparent": parent})
			_, received := otel.Tracer("test").Start(extracted, "ACP", trace.WithSpanKind(trace.SpanKindServer))
			received.End()
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	spans := recorder.Ended()
	if len(spans) != 8 {
		t.Fatalf("spans=%d", len(spans))
	}
	for _, offset := range []int{0, 4} {
		identity, received, forwarded, message := spans[offset], spans[offset+1], spans[offset+2], spans[offset+3]
		if message.Parent().IsValid() || message.SpanKind() != trace.SpanKindServer || len(message.Links()) != 1 || !message.Links()[0].SpanContext.Equal(connection.SpanContext()) {
			t.Fatal("message is not a linked root")
		}
		if identity.Parent().SpanID() != message.SpanContext().SpanID() || forwarded.Parent().SpanID() != message.SpanContext().SpanID() || received.Parent().SpanID() != forwarded.SpanContext().SpanID() || forwarded.SpanKind() != trace.SpanKindProducer {
			t.Fatal("broken message hop hierarchy")
		}
		if phaseOfACPMessageSpan(message) != "relay" || phaseOfACPMessageSpan(forwarded) != "forward" {
			t.Fatal("message spans do not identify their bounded work")
		}
	}
	if spans[3].SpanContext().TraceID() == spans[7].SpanContext().TraceID() {
		t.Fatal("messages share a connection trace")
	}
	assertNoTraceValue(t, spans, "private-canary")
}

func phaseOfACPMessageSpan(span sdktrace.ReadOnlySpan) string {
	for _, field := range span.Attributes() {
		if field.Key == "antnest.operation.phase" {
			return field.Value.AsString()
		}
	}
	return ""
}

func TestACPMessagePreservesNonRequests(t *testing.T) {
	for _, payload := range []string{`not json`, `null`, `[]`, `{"id":1,"result":{}}`, `{"jsonrpc":"2.0","method":"x","params":[]}`, `{"jsonrpc":"2.0","method":"x","params":{"_meta":42}}`} {
		t.Run(payload, func(t *testing.T) {
			recorder := recordHTTPSpans(t)
			err := RelayACPMessage(context.Background(), websocket.TextMessage, []byte(payload), nil, func(message []byte) error {
				if string(message) != payload {
					t.Fatal("changed opaque frame")
				}
				return nil
			})
			if err != nil || len(recorder.Ended()) != 0 {
				t.Fatalf("err=%v spans=%d", err, len(recorder.Ended()))
			}
		})
	}
}

func TestACPMessagePropagatesNotificationsAndPreservesRejection(t *testing.T) {
	recorder := recordHTTPSpans(t)
	failure := errors.New("rejected")
	payload := []byte(`{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}`)
	err := RelayACPMessage(context.Background(), websocket.TextMessage, payload, func(context.Context) error { return failure }, func([]byte) error { t.Fatal("forwarded rejected message"); return nil })
	if !errors.Is(err, failure) || len(recorder.Ended()) != 1 {
		t.Fatal("rejection not preserved")
	}
	err = RelayACPMessage(context.Background(), websocket.TextMessage, payload, nil, func(message []byte) error {
		var frame map[string]json.RawMessage
		if err := json.Unmarshal(message, &frame); err != nil {
			return err
		}
		if _, ok := frame["id"]; ok {
			t.Fatal("notification became request")
		}
		return failure
	})
	if !errors.Is(err, failure) || len(recorder.Ended()) != 3 {
		t.Fatal("send failure not preserved")
	}
}
