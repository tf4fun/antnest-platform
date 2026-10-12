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

func TestResolveTraceSharedDenialAndDeadlineKeepActualSource(t *testing.T) {
	for _, scenario := range []string{"inactive", "unauthenticated", "deadline"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				recorder := recordCacheTraces(t)
				gate := make(chan struct{})
				var release sync.Once
				client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
					payload := cacheTestPayload(request)
					if scenario == "deadline" {
						<-request.Context().Done()
						return nil, request.Context().Err()
					}
					<-gate
					if scenario == "unauthenticated" {
						return jsonResponse(401, `{"code":"unauthenticated","message":"denied"}`), nil
					}
					payload["principal"].(map[string]any)["active"] = false
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				defer release.Do(func() { close(gate) })
				first, firstRoot := otel.Tracer("test").Start(context.Background(), "first request")
				shared, sharedRoot := otel.Tracer("test").Start(context.Background(), "shared request")
				done := make(chan struct{}, 2)
				go func() { _, _ = client.Resolve(first, "token"); done <- struct{}{} }()
				synctest.Wait()
				go func() { _, _ = client.Resolve(shared, "token"); done <- struct{}{} }()
				synctest.Wait()
				release.Do(func() { close(gate) })
				<-done
				<-done
				client.Close()
				firstRoot.End()
				sharedRoot.End()
				marker := cacheDecisionFor(t, recorder, sharedRoot.SpanContext())
				clients := cacheClientSpans(recorder)
				outcome := "rejected"
				if scenario == "deadline" {
					outcome = "unavailable"
				}
				if len(clients) != 1 || cacheTraceAttribute(marker, "source") != "shared" || cacheTraceAttribute(marker, "shared_source_state") != "actual-client" || cacheTraceAttribute(marker, "outcome") != outcome {
					t.Fatalf("shared failure lost its actual provenance: %v", marker.Attributes())
				}
				assertCacheTraceLink(t, marker, clients[0].SpanContext())
				if scenario == "deadline" && cacheTraceAttribute(marker, "cancel_kind") != "shared-deadline" {
					t.Fatal("actual shared deadline was hidden")
				}
			})
		})
	}
}
