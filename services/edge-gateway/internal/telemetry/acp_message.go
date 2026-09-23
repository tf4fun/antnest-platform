package telemetry

import (
	"context"
	"encoding/json"
	"regexp"

	"github.com/gorilla/websocket"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var rpcMethodName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_./-]{0,127}$`)

// RelayACPMessage observes transport forwarding, never protocol execution or
// response chunks. Each message is independent of the long-lived socket span.
func RelayACPMessage(ctx context.Context, kind int, payload []byte, admit func(context.Context) error, send func([]byte) error) error {
	message, method := acpEnvelope(kind, payload)
	if message == nil {
		return forwardACPMessage(ctx, payload, admit, send)
	}
	options := []trace.SpanStartOption{trace.WithNewRoot(), trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(
		attribute.String("rpc.system.name", "jsonrpc"), attribute.String("rpc.service", "acp"),
		attribute.String("rpc.method", method), attribute.String("network.transport", "websocket"),
		attribute.String("antnest.operation.phase", "relay"),
		attribute.Int("messaging.message.body.size", len(payload)),
	)}
	if connection := trace.SpanContextFromContext(ctx); connection.IsValid() {
		options = append(options, trace.WithLinks(trace.Link{SpanContext: connection}))
	}
	tracer := otel.Tracer(instrumentationName + "/acp")
	ctx, received := tracer.Start(ctx, "acp "+method, options...)
	defer received.End()
	if admit != nil {
		if err := admit(ctx); err != nil {
			recordFailure(received, "message_admission", err)
			return err
		}
	}
	ctx, forwarded := tracer.Start(ctx, "acp "+method, trace.WithSpanKind(trace.SpanKindProducer), trace.WithAttributes(
		attribute.String("rpc.system.name", "jsonrpc"), attribute.String("rpc.service", "acp"),
		attribute.String("rpc.method", method), attribute.String("peer.service", "agent-acp-service"),
		attribute.String("antnest.operation.phase", "forward"),
	))
	defer forwarded.End()
	err := send(injectACPContext(ctx, message, payload))
	if err != nil {
		recordFailure(forwarded, "message_send", err)
		recordFailure(received, "message_send", err)
	}
	return err
}

func forwardACPMessage(ctx context.Context, payload []byte, admit func(context.Context) error, send func([]byte) error) error {
	if admit != nil {
		if err := admit(ctx); err != nil {
			return err
		}
	}
	return send(payload)
}

type acpMessage struct {
	envelope map[string]json.RawMessage
	params   map[string]json.RawMessage
	metadata map[string]json.RawMessage
}

func acpEnvelope(kind int, payload []byte) (*acpMessage, string) {
	if kind != websocket.TextMessage {
		return nil, ""
	}
	message := &acpMessage{}
	if json.Unmarshal(payload, &message.envelope) != nil || message.envelope == nil {
		return nil, ""
	}
	var method, version string
	if json.Unmarshal(message.envelope["jsonrpc"], &version) != nil || version != "2.0" ||
		json.Unmarshal(message.envelope["method"], &method) != nil || !rpcMethodName.MatchString(method) {
		return nil, ""
	}
	if _, exists := message.envelope["result"]; exists {
		return nil, ""
	}
	if _, exists := message.envelope["error"]; exists {
		return nil, ""
	}
	if raw, exists := message.envelope["params"]; exists {
		if json.Unmarshal(raw, &message.params) != nil || message.params == nil {
			return nil, ""
		}
	} else {
		message.params = make(map[string]json.RawMessage)
	}
	if raw, exists := message.params["_meta"]; exists {
		if json.Unmarshal(raw, &message.metadata) != nil {
			return nil, ""
		}
	}
	if message.metadata == nil {
		message.metadata = make(map[string]json.RawMessage)
	}
	return message, method
}

func injectACPContext(ctx context.Context, message *acpMessage, original []byte) []byte {
	if !trace.SpanContextFromContext(ctx).IsValid() {
		return original
	}
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	delete(message.metadata, "traceparent")
	delete(message.metadata, "tracestate")
	for key, value := range carrier {
		encoded, err := json.Marshal(value)
		if err != nil {
			return original
		}
		message.metadata[key] = encoded
	}
	metadata, err := json.Marshal(message.metadata)
	if err != nil {
		return original
	}
	message.params["_meta"] = metadata
	params, err := json.Marshal(message.params)
	if err != nil {
		return original
	}
	message.envelope["params"] = params
	payload, err := json.Marshal(message.envelope)
	if err != nil {
		return original
	}
	return payload
}
