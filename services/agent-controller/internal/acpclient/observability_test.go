package acpclient_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	"go.temporal.io/sdk/temporal"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
)

func recordSpans(t *testing.T) (*sdktrace.TracerProvider, *tracetest.SpanRecorder) {
	t.Helper()
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	return provider, recorder
}

func TestSnapshotTelemetryPreservesTraceWithoutCredentialPayload(t *testing.T) {
	provider, recorder := recordSpans(t)
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	ctx, parent := provider.Tracer("test").Start(t.Context(), "configuration.save")
	var transmitted trace.SpanContext
	transport := transportFunc(func(request *http.Request) (*http.Response, error) {
		transmitted = trace.SpanContextFromContext(propagation.TraceContext{}.Extract(context.Background(), propagation.HeaderCarrier(request.Header)))
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		require.Contains(t, string(body), "synthetic-current-secret")
		require.NoError(t, request.Body.Close())
		return &http.Response{StatusCode: 409, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"code":"configuration_conflict","message":"synthetic-response-secret","retryable":false}`))}, nil
	})
	client, err := acpclient.New("http://acp.internal", time.Second, &http.Client{Transport: transport})
	require.NoError(t, err)
	_, err = client.ApplyExecutionSnapshot(ctx, snapshot())
	assertFailure(t, err, "configuration_conflict", false)
	parent.End()
	spans := recorder.Ended()
	require.Len(t, spans, 2)
	clientSpan := spans[0]
	require.Equal(t, trace.SpanKindClient, clientSpan.SpanKind())
	require.Equal(t, parent.SpanContext().SpanID(), clientSpan.Parent().SpanID())
	require.Equal(t, clientSpan.SpanContext().SpanID(), transmitted.SpanID())
	require.Equal(t, parent.SpanContext().TraceID(), transmitted.TraceID())
	require.Equal(t, codes.Error, clientSpan.Status().Code)
	observed, err := json.Marshal(struct {
		Attributes any
		Events     any
	}{clientSpan.Attributes(), clientSpan.Events()})
	require.NoError(t, err)
	require.Contains(t, string(observed), "configuration_conflict")
	require.Contains(t, string(observed), "apply_execution_snapshot")
	require.NotContains(t, string(observed), "synthetic-current-secret")
	require.NotContains(t, string(observed), "synthetic-response-secret")
}

type failingBody struct {
	io.Reader
	readErr  error
	closeErr error
}

func (body failingBody) Read(value []byte) (int, error) {
	if body.readErr != nil {
		return 0, body.readErr
	}
	return body.Reader.Read(value)
}

func (body failingBody) Close() error { return body.closeErr }

func TestSnapshotFailureCannotLeakThroughTemporalErrorCauses(t *testing.T) {
	_, recorder := recordSpans(t)
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	secretFailure := errors.New("synthetic-error-secret")
	for _, phase := range []string{"transport", "read", "close"} {
		t.Run(phase, func(t *testing.T) {
			transport := transportFunc(func(request *http.Request) (*http.Response, error) {
				require.NoError(t, request.Body.Close())
				if phase == "transport" {
					return nil, secretFailure
				}
				body := failingBody{Reader: strings.NewReader(`{"organization_id":"org1","applied_revision":7}`)}
				if phase == "read" {
					body.readErr = secretFailure
				} else {
					body.closeErr = secretFailure
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: body}, nil
			})
			client, err := acpclient.New("http://acp.internal", time.Second, &http.Client{Transport: transport})
			require.NoError(t, err)
			_, err = client.ApplyExecutionSnapshot(t.Context(), snapshot())
			require.Error(t, err)
			failure := temporal.GetDefaultFailureConverter().ErrorToFailure(err)
			payload, encodeErr := protojson.Marshal(failure)
			require.NoError(t, encodeErr)
			require.NotContains(t, string(payload), "synthetic-error-secret")
			for cause := err; cause != nil; cause = errors.Unwrap(cause) {
				require.NotContains(t, cause.Error(), "synthetic-error-secret")
			}
		})
	}
	spans := recorder.Ended()
	require.Len(t, spans, 3)
	for _, span := range spans {
		payload, err := json.Marshal(struct {
			Attributes any
			Events     any
		}{span.Attributes(), span.Events()})
		require.NoError(t, err)
		require.NotContains(t, string(payload), "synthetic-error-secret")
	}
}
