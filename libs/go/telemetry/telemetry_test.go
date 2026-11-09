package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const legacyEnv = "ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES"

func installRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})
	return recorder
}

func unsetLegacyEnv(t *testing.T) {
	t.Helper()
	previous, present := os.LookupEnv(legacyEnv)
	if err := os.Unsetenv(legacyEnv); err != nil {
		t.Fatalf("unset %s: %v", legacyEnv, err)
	}
	t.Cleanup(func() {
		if present {
			_ = os.Setenv(legacyEnv, previous)
		}
	})
}

func attributeValues(attrs []attribute.KeyValue) map[attribute.Key]attribute.Value {
	values := map[attribute.Key]attribute.Value{}
	for _, attr := range attrs {
		values[attr.Key] = attr.Value
	}
	return values
}

func endedSpan(t *testing.T, recorder *tracetest.SpanRecorder, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, ended := range recorder.Ended() {
		if ended.Name() == name {
			return ended
		}
	}
	t.Fatalf("span %q not recorded: %v", name, recorder.Ended())
	return nil
}

func eventPayload(t *testing.T, recorder *tracetest.SpanRecorder, name string) string {
	t.Helper()
	for _, ended := range recorder.Ended() {
		for _, event := range ended.Events() {
			if event.Name != name {
				continue
			}
			for _, attr := range event.Attributes {
				if attr.Key == AntnestPayloadJson {
					return attr.Value.AsString()
				}
			}
		}
	}
	t.Fatalf("no %s event carrying %s", name, AntnestPayloadJson)
	return ""
}

func TestAliasAttributesEmitsCanonicalAndDeprecatedAliasByDefault(t *testing.T) {
	unsetLegacyEnv(t)
	attrs := AliasAttributes(attribute.String(AntnestAgentId, "agent-1"))
	values := attributeValues(attrs)
	if values["antnest.agent.id"].AsString() != "agent-1" ||
		values["antnest.agent_id"].AsString() != "agent-1" {
		t.Fatalf("expected canonical and alias emission, got %v", attrs)
	}
}

func TestAliasAttributesDisabledEmitsCanonicalOnly(t *testing.T) {
	for _, value := range []string{"false", "False", "FALSE", " false "} {
		t.Setenv(legacyEnv, value)
		attrs := AliasAttributes(attribute.String(AntnestAgentId, "agent-1"))
		values := attributeValues(attrs)
		if _, ok := values["antnest.agent_id"]; ok {
			t.Fatalf("alias emitted while disabled (%q): %v", value, attrs)
		}
		if values["antnest.agent.id"].AsString() != "agent-1" {
			t.Fatalf("canonical lost while disabled (%q): %v", value, attrs)
		}
	}
}

func TestAliasAttributesNormalizesAliasInputToCanonical(t *testing.T) {
	t.Setenv(legacyEnv, "false")
	attrs := AliasAttributes(attribute.String(AntnestAgentIdLegacy, "agent-1"))
	values := attributeValues(attrs)
	if _, ok := values["antnest.agent_id"]; ok {
		t.Fatalf("legacy name retained while disabled: %v", attrs)
	}
	if values["antnest.agent.id"].AsString() != "agent-1" {
		t.Fatalf("alias input not normalized to canonical: %v", attrs)
	}
}

func TestAliasAttributesCanonicalWinsConflictsInEitherOrder(t *testing.T) {
	t.Setenv(legacyEnv, "false")
	inputs := [][]attribute.KeyValue{
		{
			attribute.String(AntnestAgentIdLegacy, "legacy"),
			attribute.String(AntnestAgentId, "canonical"),
		},
		{
			attribute.String(AntnestAgentId, "canonical"),
			attribute.String(AntnestAgentIdLegacy, "legacy"),
		},
	}
	for _, input := range inputs {
		values := attributeValues(AliasAttributes(input...))
		if values["antnest.agent.id"].AsString() != "canonical" {
			t.Fatalf("canonical lost to alias input: %v", input)
		}
	}
}

func TestAliasAttributesAliasDuplicateCarriesCanonicalValue(t *testing.T) {
	t.Setenv(legacyEnv, "true")
	attrs := AliasAttributes(
		attribute.String(AntnestAgentIdLegacy, "legacy"),
		attribute.String(AntnestAgentId, "canonical"),
	)
	values := attributeValues(attrs)
	if values["antnest.agent_id"].AsString() != "canonical" {
		t.Fatalf("alias duplicate did not take the canonical value: %v", attrs)
	}
}

func TestAliasAttributesDoesNotMutateInput(t *testing.T) {
	t.Setenv(legacyEnv, "true")
	input := []attribute.KeyValue{
		attribute.String(AntnestAgentIdLegacy, "agent-1"),
		attribute.String(AntnestOutcome, "ok"),
	}
	original := append([]attribute.KeyValue(nil), input...)
	AliasAttributes(input...)
	if !reflect.DeepEqual(input, original) {
		t.Fatalf("input mutated: %v -> %v", original, input)
	}
}

func TestMetricAttributesStripsRestrictedAfterNormalization(t *testing.T) {
	t.Setenv(legacyEnv, "true")
	attrs := MetricAttributes(
		attribute.String(AntnestAgentId, "agent-1"),
		attribute.String(AntnestPayloadJson, "{}"),
		attribute.String(AntnestOutcome, "ok"),
		attribute.String("http.route", "/x"),
	)
	values := attributeValues(attrs)
	for _, key := range []string{"antnest.agent.id", "antnest.agent_id", "antnest.payload.json"} {
		if _, ok := values[attribute.Key(key)]; ok {
			t.Fatalf("restricted attribute %s retained: %v", key, attrs)
		}
	}
	if values["antnest.outcome"].AsString() != "ok" || values["http.route"].AsString() != "/x" {
		t.Fatalf("bounded or external labels not retained: %v", attrs)
	}
}

func TestMetricAttributesStripsAliasInputWhenDisabled(t *testing.T) {
	t.Setenv(legacyEnv, "false")
	attrs := MetricAttributes(
		attribute.String(AntnestAgentIdLegacy, "agent-1"),
		attribute.String(AntnestOutcome, "ok"),
	)
	values := attributeValues(attrs)
	if len(values) != 1 || values["antnest.outcome"].AsString() != "ok" {
		t.Fatalf("alias was not normalized and stripped: %v", attrs)
	}
}

type marshalProbe struct{ calls *int }

func (p marshalProbe) MarshalJSON() ([]byte, error) {
	*p.calls++
	return []byte(`"probe"`), nil
}

func TestCaptureRPCRedactsSecretKeysRecursively(t *testing.T) {
	recorder := installRecorder(t)
	_, span := otel.Tracer("test").Start(context.Background(), "capture")
	secrets := []string{
		"Password", "Password_Hash", "Authorization", "Proxy-Authorization",
		"Cookie", "Set_Cookie", "Token", "Access_Token", "Refresh-Token",
		"Id_Token", "Secret", "Client_Secret", "Api_Key", "Private_Key",
		"Credential", "Credentials", "Workload_Credential", "Caller_Context",
		"Cct", "Connection_Descriptor", "Generation_Key", "Master-Key",
		"Encryption_Key",
	}
	payload := map[string]any{}
	for _, key := range secrets {
		payload[key] = "x"
	}
	payload["nested"] = map[string]any{"PASSWORD": "x", "note": "safe"}
	payload["list"] = []any{map[string]any{"APIKEY": "x"}, "safe"}
	payload["note"] = "safe"
	CaptureRPC(span, true, "request", payload)
	span.End()
	body := eventPayload(t, recorder, AntnestRequest)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("captured payload is not JSON: %v", err)
	}
	for _, key := range secrets {
		if decoded[key] != "[REDACTED]" {
			t.Fatalf("key %s not redacted: %v", key, decoded[key])
		}
	}
	nested := decoded["nested"].(map[string]any)
	if nested["PASSWORD"] != "[REDACTED]" || nested["note"] != "safe" {
		t.Fatalf("nested object not sanitized: %v", nested)
	}
	list := decoded["list"].([]any)
	if list[0].(map[string]any)["APIKEY"] != "[REDACTED]" || list[1] != "safe" {
		t.Fatalf("array elements not sanitized: %v", list)
	}
	if decoded["note"] != "safe" {
		t.Fatalf("public value altered: %v", decoded["note"])
	}
}

func TestCaptureRPCKeepsPublicDataAndPrecision(t *testing.T) {
	recorder := installRecorder(t)
	_, span := otel.Tracer("test").Start(context.Background(), "capture")
	note := strings.Repeat("a", 20000)
	CaptureRPC(span, true, "response", map[string]any{
		"note": note,
		"big":  json.Number("9007199254740993"),
	})
	span.End()
	body := eventPayload(t, recorder, AntnestResponse)
	if !strings.Contains(body, note) {
		t.Fatalf("public string truncated in captured payload")
	}
	if !strings.Contains(body, `"big":9007199254740993`) {
		t.Fatalf("integer precision lost in captured payload: %s", body)
	}
}

func TestCaptureRPCDisabledDoesNotMarshal(t *testing.T) {
	recorder := installRecorder(t)
	_, span := otel.Tracer("test").Start(context.Background(), "capture")
	calls := 0
	CaptureRPC(span, false, "request", marshalProbe{calls: &calls})
	span.End()
	if calls != 0 {
		t.Fatalf("marshal invoked while capture disabled")
	}
	if events := recorder.Ended()[0].Events(); len(events) != 0 {
		t.Fatalf("events emitted while disabled: %v", events)
	}
}

func TestCaptureRPCNotRecordingDoesNotMarshal(t *testing.T) {
	calls := 0
	span := trace.SpanFromContext(context.Background())
	CaptureRPC(span, true, "request", marshalProbe{calls: &calls})
	if calls != 0 {
		t.Fatalf("marshal invoked on a non-recording span")
	}
}

func TestCaptureRPCIgnoresUnknownDirection(t *testing.T) {
	recorder := installRecorder(t)
	_, span := otel.Tracer("test").Start(context.Background(), "capture")
	CaptureRPC(span, true, "sideways", map[string]any{"a": 1})
	span.End()
	if events := recorder.Ended()[0].Events(); len(events) != 0 {
		t.Fatalf("unexpected events for unknown direction: %v", events)
	}
}

func TestCaptureRPCEncodingFailureRecordsCaptureError(t *testing.T) {
	recorder := installRecorder(t)
	_, span := otel.Tracer("test").Start(context.Background(), "capture")
	CaptureRPC(span, true, "request", make(chan int))
	span.End()
	found := false
	for _, ended := range recorder.Ended() {
		for _, event := range ended.Events() {
			if event.Name != AntnestCaptureError {
				continue
			}
			for _, attr := range event.Attributes {
				if attr.Key == "error.type" && attr.Value.AsString() == "json_encoding" {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatalf("no %s event with error.type json_encoding", AntnestCaptureError)
	}
}

func TestCaptureRPCDoesNotMutateInput(t *testing.T) {
	installRecorder(t)
	_, span := otel.Tracer("test").Start(context.Background(), "capture")
	payload := map[string]any{
		"Password": "x",
		"nested":   map[string]any{"Token": "y"},
	}
	before, _ := json.Marshal(payload)
	CaptureRPC(span, true, "request", payload)
	span.End()
	after, _ := json.Marshal(payload)
	if !bytes.Equal(before, after) {
		t.Fatalf("input mutated: %s -> %s", before, after)
	}
}

type trackedBody struct {
	reader   io.Reader
	readErr  error
	writeErr error
	closeErr error
	reads    int
	writes   int
	written  bytes.Buffer
}

func (b *trackedBody) Read(p []byte) (int, error) {
	b.reads++
	if b.readErr != nil {
		return 0, b.readErr
	}
	return b.reader.Read(p)
}

func (b *trackedBody) Write(p []byte) (int, error) {
	b.writes++
	if b.writeErr != nil {
		return 0, b.writeErr
	}
	return b.written.Write(p)
}

func (b *trackedBody) Close() error {
	return b.closeErr
}

type trackedReader struct {
	reader   io.Reader
	closeErr error
	reads    int
	closed   bool
}

func (b *trackedReader) Read(p []byte) (int, error) {
	b.reads++
	return b.reader.Read(p)
}

func (b *trackedReader) Close() error {
	b.closed = true
	return b.closeErr
}

func TestWrapBodyLeavesNilAndNoBodyUnchanged(t *testing.T) {
	if got := WrapBody(nil, BodyCallbacks{}); got != nil {
		t.Fatalf("nil body wrapped: %v", got)
	}
	if got := WrapBody(http.NoBody, BodyCallbacks{}); got != http.NoBody {
		t.Fatalf("NoBody replaced: %v", got)
	}
}

func TestWrapBodyDoesNotReadUntilAsked(t *testing.T) {
	body := &trackedBody{reader: strings.NewReader("data")}
	_ = WrapBody(body, BodyCallbacks{})
	if body.reads != 0 {
		t.Fatalf("wrapper read eagerly: %d reads", body.reads)
	}
}

func TestWrapBodyObservesReadWriteAndClose(t *testing.T) {
	marker := errors.New("marker")
	body := &trackedBody{reader: strings.NewReader("hello"), closeErr: marker}
	var readCalls []int
	var readErrs []error
	var closeErrs []error
	var writeCalls []int
	var writeErrs []error
	wrapped := WrapBody(body, BodyCallbacks{
		Read: func(n int, err error) {
			readCalls = append(readCalls, n)
			readErrs = append(readErrs, err)
		},
		Close: func(err error) { closeErrs = append(closeErrs, err) },
		Write: func(n int, err error) {
			writeCalls = append(writeCalls, n)
			writeErrs = append(writeErrs, err)
		},
	})
	data, err := io.ReadAll(wrapped)
	if err != nil || string(data) != "hello" {
		t.Fatalf("read failed: %v %q", err, data)
	}
	total := 0
	for _, n := range readCalls {
		total += n
	}
	if total != len("hello") {
		t.Fatalf("read byte count not observed: %v", readCalls)
	}
	if readErrs[len(readErrs)-1] != io.EOF {
		t.Fatalf("read callback did not see EOF: %v", readErrs)
	}
	writer, ok := wrapped.(io.Writer)
	if !ok {
		t.Fatalf("duplex body did not implement Writer")
	}
	if n, err := writer.Write([]byte("out")); n != 3 || err != nil || body.written.String() != "out" {
		t.Fatalf("duplex write failed: %d %v %q", n, err, body.written.String())
	}
	if writeCalls[len(writeCalls)-1] != 3 || writeErrs[len(writeErrs)-1] != nil {
		t.Fatalf("write callback did not see actual result: %v %v", writeCalls, writeErrs)
	}
	if err := wrapped.Close(); err != marker {
		t.Fatalf("close error not preserved: %v", err)
	}
	if closeErrs[len(closeErrs)-1] != marker {
		t.Fatalf("close callback did not see original error: %v", closeErrs)
	}
}

func TestWrapBodyPreservesWriteErrorIdentity(t *testing.T) {
	marker := errors.New("marker")
	body := &trackedBody{reader: strings.NewReader(""), writeErr: marker}
	var writeErrs []error
	wrapped := WrapBody(body, BodyCallbacks{
		Write: func(_ int, err error) { writeErrs = append(writeErrs, err) },
	})
	n, err := wrapped.(io.Writer).Write([]byte("x"))
	if n != 0 || err != marker {
		t.Fatalf("write error not preserved: %d %v", n, err)
	}
	if writeErrs[len(writeErrs)-1] != marker {
		t.Fatalf("write callback did not see original error: %v", writeErrs)
	}
}

func TestWrapBodyDoesNotInventWriter(t *testing.T) {
	body := &trackedReader{reader: strings.NewReader("x")}
	wrapped := WrapBody(body, BodyCallbacks{})
	if _, ok := wrapped.(io.Writer); ok {
		t.Fatalf("read-only body exposed Writer")
	}
}

type stubResponseWriter struct {
	header http.Header
	codes  []int
	body   bytes.Buffer
}

func (w *stubResponseWriter) Header() http.Header {
	if w.header == nil {
		w.header = http.Header{}
	}
	return w.header
}

func (w *stubResponseWriter) WriteHeader(code int) {
	w.codes = append(w.codes, code)
}

func (w *stubResponseWriter) Write(p []byte) (int, error) {
	return w.body.Write(p)
}

type scriptedWriter struct {
	stubResponseWriter
	queue []scriptedWrite
}

type scriptedWrite struct {
	n   int
	err error
}

func (w *scriptedWriter) Write(p []byte) (int, error) {
	if len(w.queue) == 0 {
		return w.stubResponseWriter.Write(p)
	}
	result := w.queue[0]
	w.queue = w.queue[1:]
	return result.n, result.err
}

type hijackWriter struct {
	stubResponseWriter
	conn net.Conn
	rw   *bufio.ReadWriter
	err  error
}

func (w *hijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, w.rw, w.err
}

func TestServerWriterDefaultsAndUnwrap(t *testing.T) {
	recorder := httptest.NewRecorder()
	w := NewServerWriter(recorder, context.Background(), func(error) {})
	if w.Status != http.StatusOK || w.WroteHeader || w.Written != 0 || w.WriteErr != nil {
		t.Fatalf("unexpected initial writer state: %+v", w)
	}
	if w.Unwrap() != recorder {
		t.Fatalf("Unwrap did not return the wrapped writer")
	}
}

func TestServerWriterInformationalDoesNotCommit(t *testing.T) {
	recorder := httptest.NewRecorder()
	w := NewServerWriter(recorder, context.Background(), func(error) {})
	w.WriteHeader(http.StatusEarlyHints)
	if w.WroteHeader {
		t.Fatalf("informational status committed")
	}
	w.WriteHeader(http.StatusCreated)
	w.WriteHeader(http.StatusInternalServerError)
	if !w.WroteHeader || w.Status != http.StatusCreated {
		t.Fatalf("final status not committed once: %d %v", w.Status, w.WroteHeader)
	}
}

func TestServerWriterIgnoresAllHeadersAfterFinal(t *testing.T) {
	underlying := &stubResponseWriter{}
	w := NewServerWriter(underlying, context.Background(), func(error) {})
	w.WriteHeader(http.StatusCreated)
	w.WriteHeader(http.StatusEarlyHints)
	w.WriteHeader(http.StatusInternalServerError)
	if w.Status != http.StatusCreated {
		t.Fatalf("status overwritten after final: %d", w.Status)
	}
	if len(underlying.codes) != 1 || underlying.codes[0] != http.StatusCreated {
		t.Fatalf("headers forwarded after final: %v", underlying.codes)
	}
}

func TestServerWriterSwitchingProtocolsCommits(t *testing.T) {
	w := NewServerWriter(httptest.NewRecorder(), context.Background(), func(error) {})
	w.WriteHeader(http.StatusSwitchingProtocols)
	if !w.WroteHeader || w.Status != http.StatusSwitchingProtocols {
		t.Fatalf("101 did not commit: %d %v", w.Status, w.WroteHeader)
	}
}

func TestServerWriterWriteCountsActualAndKeepsFirstError(t *testing.T) {
	marker := errors.New("marker")
	second := errors.New("second")
	underlying := &scriptedWriter{queue: []scriptedWrite{{n: 2, err: marker}, {n: 3, err: second}}}
	var callbackErrs []error
	w := NewServerWriter(underlying, context.Background(), func(err error) {
		callbackErrs = append(callbackErrs, err)
	})
	if n, err := w.Write([]byte("hello")); n != 2 || err != marker {
		t.Fatalf("short write not passed through: %d %v", n, err)
	}
	if w.Written != 2 || w.WriteErr != marker {
		t.Fatalf("write accounting wrong: %d %v", w.Written, w.WriteErr)
	}
	if n, err := w.Write([]byte("hello")); n != 3 || err != second {
		t.Fatalf("second write not passed through: %d %v", n, err)
	}
	if w.Written != 5 || w.WriteErr != marker {
		t.Fatalf("first error not retained: %d %v", w.Written, w.WriteErr)
	}
	if len(callbackErrs) == 0 || callbackErrs[0] != marker {
		t.Fatalf("error callback did not see first error: %v", callbackErrs)
	}
}

func TestServerWriterReadFromCountsThroughWrite(t *testing.T) {
	underlying := &stubResponseWriter{}
	w := NewServerWriter(underlying, context.Background(), func(error) {})
	n, err := io.Copy(w, strings.NewReader("abcdef"))
	if err != nil || n != 6 {
		t.Fatalf("copy failed: %d %v", n, err)
	}
	if underlying.body.String() != "abcdef" {
		t.Fatalf("ReadFrom bypassed Write: %q", underlying.body.String())
	}
	if w.Written != 6 {
		t.Fatalf("ReadFrom bytes not counted: %d", w.Written)
	}
}

func TestServerWriterFlushDelegatesAndRetainsError(t *testing.T) {
	recorder := httptest.NewRecorder()
	w := NewServerWriter(recorder, context.Background(), func(error) {})
	w.Flush()
	if !recorder.Flushed {
		t.Fatalf("flush not delegated")
	}
	if err := w.FlushError(); err != nil {
		t.Fatalf("flush error reported after success: %v", err)
	}
	broken := NewServerWriter(&stubResponseWriter{}, context.Background(), func(error) {})
	broken.Flush()
	if err := broken.FlushError(); err == nil {
		t.Fatalf("unsupported flush did not report an error")
	}
}

func TestServerWriterHijackReturnsUnderlyingResult(t *testing.T) {
	client, server := net.Pipe()
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})
	buffered := bufio.NewReadWriter(
		bufio.NewReader(strings.NewReader("")),
		bufio.NewWriter(io.Discard),
	)
	marker := errors.New("marker")
	underlying := &hijackWriter{conn: server, rw: buffered, err: marker}
	w := NewServerWriter(underlying, context.Background(), func(error) {})
	conn, rw, err := w.Hijack()
	if conn != server || rw != buffered || err != marker {
		t.Fatalf("hijack result not preserved: %v %v %v", conn, rw, err)
	}
}

func TestServerWriterPushReportsUnsupported(t *testing.T) {
	w := NewServerWriter(httptest.NewRecorder(), context.Background(), func(error) {})
	if err := w.Push("/x", nil); !errors.Is(err, http.ErrNotSupported) {
		t.Fatalf("expected ErrNotSupported, got %v", err)
	}
}

func remoteContext(t *testing.T) context.Context {
	t.Helper()
	traceID, err := trace.TraceIDFromHex("00112233445566778899aabbccddeeff")
	if err != nil {
		t.Fatalf("trace id: %v", err)
	}
	spanID, err := trace.SpanIDFromHex("0011223344556677")
	if err != nil {
		t.Fatalf("span id: %v", err)
	}
	remote := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	})
	return trace.ContextWithRemoteSpanContext(context.Background(), remote)
}

func TestStartServerExtractsRemoteParent(t *testing.T) {
	recorder := installRecorder(t)
	parent := trace.SpanContextFromContext(remoteContext(t))
	request := httptest.NewRequest(http.MethodPost, "http://example.com/rpc", nil)
	propagation.TraceContext{}.Inject(
		remoteContext(t),
		propagation.HeaderCarrier(request.Header),
	)
	request.Header.Set("Baggage", "key=value")
	gotContext, span := StartServer(
		request,
		"test-instrumentation",
		propagation.TraceContext{},
	)
	if span == nil {
		t.Fatalf("no server span returned")
	}
	span.End()
	if got := trace.SpanFromContext(gotContext); got.SpanContext().SpanID() != span.SpanContext().SpanID() {
		t.Fatalf("returned context does not carry the server span")
	}
	serverSpan := endedSpan(t, recorder, "HTTP POST")
	if serverSpan.SpanKind() != trace.SpanKindServer {
		t.Fatalf("unexpected span kind: %v", serverSpan.SpanKind())
	}
	if serverSpan.Parent().SpanID() != parent.SpanID() ||
		serverSpan.Parent().TraceID() != parent.TraceID() {
		t.Fatalf("remote parent not extracted: %v", serverSpan.Parent())
	}
}

func TestStartServerDefaultsToTraceContext(t *testing.T) {
	recorder := installRecorder(t)
	request := httptest.NewRequest(http.MethodGet, "http://example.com/x", nil)
	propagation.TraceContext{}.Inject(
		remoteContext(t),
		propagation.HeaderCarrier(request.Header),
	)
	_, span := StartServer(request, "test", nil)
	span.End()
	serverSpan := endedSpan(t, recorder, "HTTP GET")
	if serverSpan.Parent().TraceID().String() != "00112233445566778899aabbccddeeff" {
		t.Fatalf("default propagator did not extract W3C context")
	}
}

func TestCloneRequestInjectsContextAndRemovesBaggage(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://example.com/x", nil)
	request.Header.Set("Baggage", "key=value")
	request.Header.Set("X-Keep", "keep")
	ctx := remoteContext(t)
	clone := CloneRequest(request, ctx, propagation.TraceContext{})
	if clone == request {
		t.Fatalf("request was not cloned")
	}
	passed := trace.SpanContextFromContext(ctx)
	cloned := trace.SpanContextFromContext(clone.Context())
	if cloned.TraceID() != passed.TraceID() || cloned.SpanID() != passed.SpanID() {
		t.Fatalf("clone did not adopt the passed context")
	}
	if trace.SpanContextFromContext(request.Context()).IsValid() {
		t.Fatalf("original request context replaced")
	}
	if clone.Header.Get("Baggage") != "" {
		t.Fatalf("baggage header retained: %v", clone.Header)
	}
	if clone.Header.Get("X-Keep") != "keep" {
		t.Fatalf("existing headers not cloned: %v", clone.Header)
	}
	parent := clone.Header.Get("traceparent")
	if !strings.Contains(parent, "00112233445566778899aabbccddeeff") {
		t.Fatalf("context not injected: %v", clone.Header)
	}
	if request.Header.Get("traceparent") != "" || request.Header.Get("Baggage") != "key=value" {
		t.Fatalf("original request mutated: %v", request.Header)
	}
}

func TestCloneRequestHandlesNilHeader(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://example.com/x", nil)
	request.Header = nil
	clone := CloneRequest(request, remoteContext(t), nil)
	if clone.Header == nil || clone.Header.Get("traceparent") == "" {
		t.Fatalf("nil header clone missing injection: %v", clone.Header)
	}
	if request.Header != nil {
		t.Fatalf("original request mutated: %v", request.Header)
	}
}

type canaryError struct{ calls *int }

func (e *canaryError) Error() string {
	*e.calls++
	return "canary"
}

type cyclicError struct{ next error }

func (e *cyclicError) Error() string { return "cyclic" }

func (e *cyclicError) Unwrap() []error { return []error{e.next} }

func TestCauseTypesWalksWrappedAndJoinedErrors(t *testing.T) {
	leaf := errors.New("leaf")
	types := CauseTypes(fmt.Errorf("outer: %w", leaf), 10)
	joined := strings.Join(types, ",")
	if !strings.Contains(joined, "*fmt.wrapError") ||
		!strings.Contains(joined, "*errors.errorString") {
		t.Fatalf("wrapped causes missing: %v", types)
	}
	multi := errors.Join(errors.New("a"), fmt.Errorf("w: %w", leaf))
	types = CauseTypes(multi, 10)
	joined = strings.Join(types, ",")
	if !strings.Contains(joined, "*errors.joinError") ||
		!strings.Contains(joined, "*errors.errorString") ||
		!strings.Contains(joined, "*fmt.wrapError") {
		t.Fatalf("joined causes missing: %v", types)
	}
}

func TestCauseTypesRespectsLimitAndSurvivesCycles(t *testing.T) {
	err := error(errors.New("leaf"))
	for i := 0; i < 8; i++ {
		err = fmt.Errorf("wrap %d: %w", i, err)
	}
	if types := CauseTypes(err, 3); len(types) > 3 {
		t.Fatalf("limit ignored: %v", types)
	}
	cyclic := &cyclicError{}
	cyclic.next = cyclic
	if types := CauseTypes(cyclic, 4); len(types) > 4 {
		t.Fatalf("cycle traversal not bounded: %v", types)
	}
}

func TestCauseTypesNeverCallsError(t *testing.T) {
	calls := 0
	CauseTypes(&canaryError{calls: &calls}, 10)
	if calls != 0 {
		t.Fatalf("Error() invoked during cause traversal")
	}
}
