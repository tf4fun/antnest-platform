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
)

func TestResolveTraceCreatorCancellationSnapshotsPublishedClient(t *testing.T) {
	for _, kind := range []string{"caller-cancelled", "caller-deadline", "shared-deadline", "process-shutdown"} {
		for _, published := range []bool{false, true} {
			name := kind + "/before-client"
			if published {
				name = kind + "/actual-client"
			}
			t.Run(name, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					recorder := recordCacheTraces(t)
					release := make(chan struct{})
					var releaseOnce sync.Once
					client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
						<-request.Context().Done()
						if published {
							<-release
						}
						return nil, request.Context().Err()
					})
					defer client.Close()
					defer releaseOnce.Do(func() { close(release) })
					if !published {
						transport := client.httpClient.Transport
						client.httpClient.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
							<-release
							return transport.RoundTrip(request)
						})
					}
					ctx, root := otel.Tracer("test").Start(context.Background(), "creator request")
					defer root.End()
					var cancel context.CancelFunc
					if kind == "caller-deadline" {
						ctx, cancel = context.WithTimeout(ctx, time.Second)
					} else {
						ctx, cancel = context.WithCancel(ctx)
					}
					defer cancel()
					finished := make(chan error, 1)
					go func() { _, err := client.Resolve(ctx, "private-creator-token"); finished <- err }()
					synctest.Wait()
					client.cache.mu.Lock()
					retained := len(client.cache.retained)
					actualPublished := false
					for flight := range client.cache.retained {
						actualPublished = flight.rpcSpan.IsValid()
					}
					client.cache.mu.Unlock()
					if retained != 1 || actualPublished != published {
						t.Fatal("fixture did not hold the expected CLIENT publication state")
					}
					switch kind {
					case "caller-cancelled":
						cancel()
					case "caller-deadline":
						time.Sleep(time.Second)
					case "shared-deadline":
						time.Sleep(5 * time.Second)
					case "process-shutdown":
						client.cache.cancel()
					}
					synctest.Wait()
					select {
					case err := <-finished:
						if kind == "process-shutdown" {
							if !IsCode(err, "identity_unavailable") {
								t.Fatalf("shutdown outcome changed: %v", err)
							}
						} else {
							want := context.DeadlineExceeded
							if kind == "caller-cancelled" {
								want = context.Canceled
							}
							if !errors.Is(err, want) {
								t.Fatalf("creator cancellation outcome changed: %v", err)
							}
						}
					default:
						t.Fatal("creator waited for transport cleanup to emit its diagnostics")
					}
					marker := cacheDecisionFor(t, recorder, root.SpanContext())
					var wantKind any
					if published {
						wantKind = kind
					}
					if cacheTraceAttribute(marker, "source") != "rpc" ||
						cacheTraceAttribute(marker, "outcome") != "unavailable" ||
						cacheTraceAttribute(marker, "cancel_kind") != wantKind ||
						cacheTraceAttribute(marker, "shared_source_state") != nil || len(marker.Links()) != 0 {
						t.Fatalf("creator cancellation lost its publication snapshot: %v", marker.Attributes())
					}
					client.cache.mu.Lock()
					active, waiters := client.cache.active, client.cache.waiters
					client.cache.mu.Unlock()
					if active != 1 || waiters != 0 || len(cacheClientSpans(recorder)) != 0 {
						t.Fatal("diagnostics must release the caller while retaining unfinished transport work")
					}
					releaseOnce.Do(func() { close(release) })
					client.Close()
					if len(cacheClientSpans(recorder)) != 1 || cacheTraceAttribute(marker, "cancel_kind") != wantKind {
						t.Fatal("later CLIENT cleanup changed the original cancellation snapshot")
					}
					assertCacheTracePrivacy(t, recorder, "private-creator-token")
				})
			})
		}
	}
}
