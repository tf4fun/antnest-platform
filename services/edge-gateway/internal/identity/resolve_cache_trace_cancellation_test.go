package identity

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type clientCreationGate struct {
	created chan trace.SpanContext
	release chan struct{}
}

func (gate *clientCreationGate) OnStart(_ context.Context, span sdktrace.ReadWriteSpan) {
	if span.SpanKind() == trace.SpanKindClient {
		gate.created <- span.SpanContext()
		<-gate.release
	}
}

func (*clientCreationGate) OnEnd(sdktrace.ReadOnlySpan)      {}
func (*clientCreationGate) Shutdown(context.Context) error   { return nil }
func (*clientCreationGate) ForceFlush(context.Context) error { return nil }

func TestResolveTraceCancellationBeforeClientDoesNotWaitForOrInventSource(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		recorder := recordCacheTraces(t)
		allowClient := make(chan struct{})
		var release sync.Once
		client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
			return cacheTestResponse(cacheTestPayload(request)), nil
		})
		defer client.Close()
		defer release.Do(func() { close(allowClient) })
		instrumented := client.httpClient.Transport
		client.httpClient.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
			<-allowClient
			return instrumented.RoundTrip(request)
		})
		ownerCtx, owner := otel.Tracer("test").Start(context.Background(), "owning request")
		waiterCtx, waiter := otel.Tracer("test").Start(context.Background(), "cancelled waiter")
		waiterCtx, cancel := context.WithCancel(waiterCtx)
		defer cancel()
		ownerDone, waiterDone := make(chan error, 1), make(chan error, 1)
		go func() { _, err := client.Resolve(ownerCtx, "token"); ownerDone <- err }()
		synctest.Wait()
		go func() { _, err := client.Resolve(waiterCtx, "token"); waiterDone <- err }()
		synctest.Wait()
		cancel()
		synctest.Wait()
		select {
		case err := <-waiterDone:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled waiter outcome changed: %v", err)
			}
		default:
			t.Fatal("cancelled waiter waited for a future RPC just to obtain a link")
		}
		waiter.End()
		marker := cacheDecisionFor(t, recorder, waiter.SpanContext())
		if len(marker.Links()) != 0 || len(cacheClientSpans(recorder)) != 0 || cacheTraceAttribute(marker, "source") != "shared" ||
			cacheTraceAttribute(marker, "shared_source_state") != "cancelled-before-client" || cacheTraceAttribute(marker, "outcome") != "unavailable" || cacheTraceAttribute(marker, "cancel_kind") != "caller-cancelled" {
			t.Fatalf("early cancellation invented or misclassified its source: %v", marker.Attributes())
		}
		release.Do(func() { close(allowClient) })
		if err := <-ownerDone; err != nil {
			t.Fatal(err)
		}
		owner.End()
		if len(cacheClientSpans(recorder)) != 1 {
			t.Fatal("independent owner lost its later real RPC")
		}
	})
}

func TestResolveTraceCreatedButUnpublishedClientCannotUseCancellationException(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := &clientCreationGate{created: make(chan trace.SpanContext, 1), release: make(chan struct{})}
		recorder := recordCacheTraces(t, gate)
		allowClient, allowResponse := make(chan struct{}), make(chan struct{})
		var releaseClient, releasePublication, releaseResponse sync.Once
		client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
			payload := cacheTestPayload(request)
			<-allowResponse
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer releaseResponse.Do(func() { close(allowResponse) })
		defer releasePublication.Do(func() { close(gate.release) })
		defer releaseClient.Do(func() { close(allowClient) })
		instrumented := client.httpClient.Transport
		client.httpClient.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
			<-allowClient
			return instrumented.RoundTrip(request)
		})
		ownerCtx, owner := otel.Tracer("test").Start(context.Background(), "owning request")
		waiterCtx, waiter := otel.Tracer("test").Start(context.Background(), "cancelled waiter")
		waiterCtx, cancel := context.WithCancel(waiterCtx)
		defer cancel()
		ownerDone, waiterDone := make(chan error, 1), make(chan error, 1)
		go func() { _, err := client.Resolve(ownerCtx, "token"); ownerDone <- err }()
		synctest.Wait()
		go func() { _, err := client.Resolve(waiterCtx, "token"); waiterDone <- err }()
		synctest.Wait()
		releaseClient.Do(func() { close(allowClient) })
		actual := <-gate.created // SDK allocated CLIENT, observer has not published it.
		cancel()
		// Do not wait for the waiter while the deliberate SDK gate holds the
		// publication mutex; cancellation must snapshot after that atomic step.
		releasePublication.Do(func() { close(gate.release) })
		if err := <-waiterDone; !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled waiter outcome changed: %v", err)
		}
		waiter.End()
		marker := cacheDecisionFor(t, recorder, waiter.SpanContext())
		if cacheTraceAttribute(marker, "shared_source_state") != "actual-client" || cacheTraceAttribute(marker, "outcome") != "unavailable" || cacheTraceAttribute(marker, "cancel_kind") != "caller-cancelled" {
			t.Fatalf("created CLIENT was mistaken for absent provenance: %v", marker.Attributes())
		}
		assertCacheTraceLink(t, marker, actual)
		releaseResponse.Do(func() { close(allowResponse) })
		if err := <-ownerDone; err != nil {
			t.Fatal(err)
		}
		owner.End()
		clients := cacheClientSpans(recorder)
		if len(clients) != 1 || !clients[0].SpanContext().Equal(actual) {
			t.Fatal("published source did not match the archived actual CLIENT")
		}
	})
}
