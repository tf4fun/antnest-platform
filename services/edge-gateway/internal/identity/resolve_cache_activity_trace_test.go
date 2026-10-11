package identity

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

func TestResolveCacheActivityPreservesActualRPCAndSharedProvenance(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		recorder := recordCacheTraces(t)
		gate := make(chan struct{})
		var release sync.Once
		var calls, touches atomic.Int64
		var authority Principal
		client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/rpc/identity/resolve-access-token" {
				touches.Add(1)
				return cacheTestResponse(activityReply(authority)), nil
			}
			payload := cacheTestPayload(request)
			if calls.Add(1) == 2 {
				select {
				case <-gate:
				case <-request.Context().Done():
					return nil, request.Context().Err()
				}
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		warm, warmRoot := otel.Tracer("test").Start(context.Background(), "warm")
		var err error
		authority, err = client.Resolve(warm, "activity-private-canary")
		warmRoot.End()
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Second)
		firstCtx, firstRoot := otel.Tracer("test").Start(context.Background(), "first")
		defer firstRoot.End()
		sharedCtx, sharedRoot := otel.Tracer("test").Start(context.Background(), "shared")
		defer sharedRoot.End()
		first := activityRead(client, firstCtx, "activity-private-canary")
		synctest.Wait()
		shared := activityRead(client, sharedCtx, "activity-private-canary")
		synctest.Wait()
		if err := cacheMutation(client, "activity", authority); err != nil {
			t.Fatal(err)
		}
		newCtx, newRoot := otel.Tracer("test").Start(context.Background(), "new")
		if principal, err := client.Resolve(newCtx, "activity-private-canary"); err != nil || principal.ResolveCacheHit {
			t.Fatalf("new generation failed: %v", err)
		}
		newRoot.End()
		release.Do(func() { close(gate) })
		for _, reader := range []<-chan cacheResolveResult{first, shared} {
			if result := <-reader; result.err != nil || result.principal.ResolveCacheHit {
				t.Fatalf("obsolete live reader was lost or reclassified: %v", result.err)
			}
		}
		synctest.Wait()
		clients := cacheClientSpans(recorder)
		if calls.Load() != 3 || touches.Load() != 1 || len(clients) != 4 {
			t.Fatal("obsolete work disappeared from actual RPC accounting or retried")
		}
		var actual trace.SpanContext
		for _, span := range clients {
			if span.Parent().Equal(firstRoot.SpanContext()) {
				if actual.IsValid() {
					t.Fatal("first generation owns multiple actual CLIENT spans")
				}
				actual = span.SpanContext()
			}
		}
		if !actual.IsValid() {
			t.Fatal("obsolete generation lost its actual CLIENT parent")
		}
		for _, item := range []struct {
			parent trace.SpanContext
			source string
		}{{firstRoot.SpanContext(), "rpc"}, {sharedRoot.SpanContext(), "shared"}, {newRoot.SpanContext(), "rpc"}} {
			marker := cacheDecisionFor(t, recorder, item.parent)
			if cacheTraceAttribute(marker, "source") != item.source || cacheTraceAttribute(marker, "outcome") != "admitted" {
				t.Fatal("activity changed live decision source or outcome")
			}
			if item.source == "shared" {
				assertCacheTraceLink(t, marker, actual)
				if cacheTraceAttribute(marker, "shared_source_state") != "actual-client" || cacheTraceAttribute(marker, "cancel_kind") != nil {
					t.Fatal("activity fabricated a shared cancellation")
				}
			}
		}
		assertCacheTracePrivacy(t, recorder, "activity-private-canary", authority.SessionID, authority.CallerContext)
	})
}
