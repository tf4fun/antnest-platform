package telemetry

import (
	"bytes"
	"encoding/json"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

const redactedValue = "[REDACTED]"

var secretKeys = map[string]bool{
	"password":             true,
	"passwordhash":         true,
	"authorization":        true,
	"proxyauthorization":   true,
	"cookie":               true,
	"setcookie":            true,
	"token":                true,
	"accesstoken":          true,
	"refreshtoken":         true,
	"idtoken":              true,
	"secret":               true,
	"clientsecret":         true,
	"apikey":               true,
	"privatekey":           true,
	"credential":           true,
	"credentials":          true,
	"workloadcredential":   true,
	"callercontext":        true,
	"cct":                  true,
	"connectiondescriptor": true,
	"generationkey":        true,
	"masterkey":            true,
	"encryptionkey":        true,
}

var keyNormalizer = strings.NewReplacer("-", "", "_", "")

func sanitizeJSON(value any) any {
	switch item := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(item))
		for key, member := range item {
			if secretKeys[keyNormalizer.Replace(strings.ToLower(key))] {
				out[key] = redactedValue
				continue
			}
			out[key] = sanitizeJSON(member)
		}
		return out
	case []any:
		out := make([]any, len(item))
		for index, member := range item {
			out[index] = sanitizeJSON(member)
		}
		return out
	default:
		return value
	}
}

func captureError(span trace.Span) {
	span.AddEvent(
		AntnestCaptureError,
		trace.WithAttributes(attribute.String("error.type", "json_encoding")),
	)
}

func CaptureRPC(span trace.Span, enabled bool, direction string, value any) {
	if !enabled || !span.IsRecording() {
		return
	}
	var event string
	switch direction {
	case "request":
		event = AntnestRequest
	case "response":
		event = AntnestResponse
	default:
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		captureError(span)
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		captureError(span)
		return
	}
	body, err := json.Marshal(sanitizeJSON(decoded))
	if err != nil {
		captureError(span)
		return
	}
	span.AddEvent(
		event,
		trace.WithAttributes(attribute.String(AntnestPayloadJson, string(body))),
	)
}
