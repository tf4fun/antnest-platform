package identity

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"go.opentelemetry.io/otel"
)

func TestResolveTraceCapacityRejectionDoesNotClaimSharedSource(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		recorder := recordCacheTraces(t)
		gate := make(chan struct{})
		var release sync.Once
		client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
			payload := cacheTestPayload(request)
			<-gate
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		completed := make(chan error, resolveCacheScopeWaiters)
		for range resolveCacheScopeWaiters {
			go func() { _, err := client.Resolve(context.Background(), "token"); completed <- err }()
		}
		synctest.Wait()
		ctx, root := otel.Tracer("test").Start(context.Background(), "capacity rejected request")
		_, err := client.Resolve(ctx, "token")
		root.End()
		if !IsCode(err, "identity_unavailable") {
			t.Fatalf("fixture did not exhaust the waiter limit: %v", err)
		}
		marker := cacheDecisionFor(t, recorder, root.SpanContext())
		if cacheTraceAttribute(marker, "source") != "rpc" || cacheTraceAttribute(marker, "outcome") != "unavailable" ||
			cacheTraceAttribute(marker, "shared_source_state") != nil || len(marker.Links()) != 0 {
			t.Fatalf("capacity rejection claimed work it never joined: %v", marker.Attributes())
		}
		release.Do(func() { close(gate) })
		for range resolveCacheScopeWaiters {
			if err := <-completed; err != nil {
				t.Fatal(err)
			}
		}
	})
}
