package acpclient_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
)

// These barriers observe an actual TCP response body. They do not replace the
// production RPC or alter span timestamps, and make no cross-process clock claim.
func TestSnapshotRealHTTPSpanWaitsForBodyAndProtocol(t *testing.T) {
	for _, organization := range []string{"org1", "other-organization"} {
		t.Run(organization, func(t *testing.T) {
			provider, recorder := recordSpans(t)
			events := make(chan string, 8)
			provider.RegisterSpanProcessor(lifecycleEndObserver{ended: func() { events <- "span_ended" }})
			incoming := make(chan trace.SpanContext, 1)
			serverErrors := make(chan error, 1)
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				incoming <- trace.SpanContextFromContext(propagation.TraceContext{}.Extract(context.Background(), propagation.HeaderCarrier(request.Header)))
				_, readErr := io.Copy(io.Discard, request.Body)
				closeErr := request.Body.Close()
				writer.Header().Set("Content-Type", "application/json")
				_, writeErr := io.WriteString(writer, `{"organization_id":"`+organization+`","applied_revision":7}`)
				serverErrors <- errors.Join(readErr, closeErr, writeErr)
			}))
			t.Cleanup(server.Close)
			base := http.DefaultTransport.(*http.Transport).Clone()
			t.Cleanup(base.CloseIdleConnections)
			eofSeen, closeSeen := make(chan struct{}), make(chan struct{})
			allowEOF, allowClose := make(chan struct{}), make(chan struct{})
			var releaseEOF, releaseClose sync.Once
			release := func() {
				releaseEOF.Do(func() { close(allowEOF) })
				releaseClose.Do(func() { close(allowClose) })
			}
			transport := transportFunc(func(request *http.Request) (*http.Response, error) {
				response, err := base.RoundTrip(request)
				if err == nil {
					response.Body = &lifecycleResponseBody{
						ReadCloser: response.Body, events: events,
						eofSeen: eofSeen, closeSeen: closeSeen,
						allowEOF: allowEOF, allowClose: allowClose,
					}
				}
				return response, err
			})
			client, err := acpclient.New(server.URL, 5*time.Second, &http.Client{Transport: transport})
			require.NoError(t, err)
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan struct{})
			var callErr error
			go func() {
				defer close(done)
				_, callErr = client.ApplyExecutionSnapshot(ctx, snapshot())
				events <- "call_returned"
			}()
			t.Cleanup(func() {
				cancel()
				release()
				awaitLifecycle(t, done)
			})

			awaitLifecycle(t, eofSeen)
			require.Empty(t, recorder.Ended(), "CLIENT ended before the real body returned EOF")
			releaseEOF.Do(func() { close(allowEOF) })
			awaitLifecycle(t, closeSeen)
			require.Empty(t, recorder.Ended(), "CLIENT ended before Close returned to the RPC")
			releaseClose.Do(func() { close(allowClose) })
			awaitLifecycle(t, done)
			require.NoError(t, <-serverErrors)
			spans := recorder.Ended()
			require.Len(t, spans, 1)
			span := spans[0]
			require.Equal(t, trace.SpanKindClient, span.SpanKind())
			received := <-incoming
			require.True(t, received.IsValid())
			require.Equal(t, span.SpanContext().TraceID(), received.TraceID())
			require.Equal(t, span.SpanContext().SpanID(), received.SpanID())
			attrs := map[string]any{}
			for _, attr := range span.Attributes() {
				attrs[string(attr.Key)] = attr.Value.AsInterface()
			}
			if organization == "org1" {
				require.NoError(t, callErr)
				require.Equal(t, codes.Unset, span.Status().Code)
				require.Equal(t, int64(7), attrs["antnest.configuration.applied_revision"])
			} else {
				assertFailure(t, callErr, "invalid_response", true)
				require.Equal(t, codes.Error, span.Status().Code)
				require.NotContains(t, attrs, "antnest.configuration.applied_revision")
			}
			close(events)
			var observed []string
			for event := range events {
				observed = append(observed, event)
			}
			require.Equal(t, []string{"body_eof", "body_closed", "span_ended", "call_returned"}, observed)
		})
	}
}

func awaitLifecycle(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP lifecycle did not settle")
	}
}

type lifecycleResponseBody struct {
	io.ReadCloser
	events               chan<- string
	eofSeen, closeSeen   chan struct{}
	allowEOF, allowClose <-chan struct{}
	eof                  sync.Once
}

func (body *lifecycleResponseBody) Read(buffer []byte) (int, error) {
	n, err := body.ReadCloser.Read(buffer)
	if errors.Is(err, io.EOF) {
		body.eof.Do(func() {
			body.events <- "body_eof"
			close(body.eofSeen)
			<-body.allowEOF
		})
	}
	return n, err
}

func (body *lifecycleResponseBody) Close() error {
	err := body.ReadCloser.Close()
	body.events <- "body_closed"
	close(body.closeSeen)
	<-body.allowClose
	return err
}

type lifecycleEndObserver struct{ ended func() }

func (lifecycleEndObserver) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (observer lifecycleEndObserver) OnEnd(sdktrace.ReadOnlySpan)            { observer.ended() }
func (lifecycleEndObserver) Shutdown(context.Context) error                  { return nil }
func (lifecycleEndObserver) ForceFlush(context.Context) error                { return nil }
