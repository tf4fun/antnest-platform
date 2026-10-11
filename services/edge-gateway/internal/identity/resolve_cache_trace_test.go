package identity

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func TestResolveTraceMissPreservesActualRPCParentAndEndsBeforeAdmission(t *testing.T) {
	for _, ttl := range []time.Duration{0, 10 * time.Second} {
		t.Run(ttl.String(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				recorder := recordCacheTraces(t)
				client := cacheTraceClient(t, ttl, func(request *http.Request) (*http.Response, error) {
					return cacheTestResponse(cacheTestPayload(request)), nil
				})
				defer client.Close()
				ctx, root := otel.Tracer("test").Start(context.Background(), "Gateway request", trace.WithSpanKind(trace.SpanKindServer))
				principal, err := client.Resolve(WithResolution(ctx, "acp", "agent-A"), "private-browser-canary")
				if err != nil {
					t.Fatal(err)
				}
				_, upstream := otel.Tracer("test").Start(ctx, "upstream admission")
				upstream.End()
				root.End()
				marker := cacheDecisionFor(t, recorder, root.SpanContext())
				clients := cacheClientSpans(recorder)
				if len(clients) != 1 || marker.SpanKind() != trace.SpanKindInternal || clients[0].Parent().SpanID() != root.SpanContext().SpanID() ||
					cacheTraceAttribute(marker, "source") != "rpc" || cacheTraceAttribute(marker, "profile") != "acp" || cacheTraceAttribute(marker, "outcome") != "admitted" {
					t.Fatal("miss marker replaced the true RPC ancestry or lost its admission facts")
				}
				for _, span := range recorder.Ended() {
					if span.Name() == "upstream admission" && marker.EndTime().After(span.StartTime()) {
						t.Fatal("decision marker continued past upstream admission")
					}
					if span.Name() == "Identity Resolve" && span.Parent().SpanID() != clients[0].SpanContext().SpanID() {
						t.Fatal("Identity SERVER lost its actual CLIENT parent")
					}
				}
				assertCacheTracePrivacy(t, recorder, "private-browser-canary", principal.SessionID, principal.CallerContext)
			})
		})
	}
}

func TestResolveTraceCacheHitRecordsImmutableFractionalBudgetsWithoutRPC(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		recorder := recordCacheTraces(t)
		client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
			return cacheTestResponse(cacheTestPayload(request)), nil
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		warm, warmRoot := otel.Tracer("test").Start(context.Background(), "warm request")
		if _, err := client.Resolve(warm, "token"); err != nil {
			t.Fatal(err)
		}
		warmRoot.End()
		time.Sleep(2*time.Second + 500*time.Microsecond)
		client.SessionFeedCaughtUp(time.Now().Add(-time.Second - 250*time.Microsecond))
		ctx, root := otel.Tracer("test").Start(context.Background(), "ACP message")
		principal, err := client.Resolve(ctx, "token")
		if err != nil || !principal.ResolveCacheHit {
			t.Fatalf("fixture did not hit: %v", err)
		}
		root.End()
		client.SessionFeedCaughtUp(time.Now())
		marker := cacheDecisionFor(t, recorder, root.SpanContext())
		if len(cacheClientSpans(recorder)) != 1 || cacheTraceAttribute(marker, "source") != "cache" || cacheTraceAttribute(marker, "outcome") != "admitted" ||
			cacheTraceAttribute(marker, "snapshot_age_ms") != 2000.5 || cacheTraceAttribute(marker, "proof_age_ms") != 1000.25 || cacheTraceAttribute(marker, "valid_for_ms") != 7999.5 {
			t.Fatalf("hit fabricated an RPC, truncated budgets, or read mutable proof later: %v", marker.Attributes())
		}
	})
}

func TestResolveTraceSharedWaiterLinksRealRPCDespiteFirstRequestCancellation(t *testing.T) {
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
		firstCtx, firstRoot := otel.Tracer("test").Start(context.Background(), "first request")
		firstCtx, cancelFirst := context.WithCancel(firstCtx)
		defer cancelFirst()
		secondCtx, secondRoot := otel.Tracer("test").Start(context.Background(), "second request")
		first, second := make(chan error, 1), make(chan error, 1)
		go func() { _, err := client.Resolve(firstCtx, "token"); first <- err }()
		synctest.Wait()
		go func() { _, err := client.Resolve(secondCtx, "token"); second <- err }()
		synctest.Wait()
		cancelFirst()
		if err := <-first; !errors.Is(err, context.Canceled) {
			t.Fatalf("leader did not detach: %v", err)
		}
		firstRoot.End()
		time.Sleep(time.Millisecond)
		release.Do(func() { close(gate) })
		if err := <-second; err != nil {
			t.Fatal(err)
		}
		secondRoot.End()
		clients := cacheClientSpans(recorder)
		marker := cacheDecisionFor(t, recorder, secondRoot.SpanContext())
		if len(clients) != 1 || clients[0].Parent().SpanID() != firstRoot.SpanContext().SpanID() || clients[0].SpanContext().TraceID() == marker.SpanContext().TraceID() ||
			cacheTraceAttribute(marker, "source") != "shared" || cacheTraceAttribute(marker, "shared_source_state") != "actual-client" || cacheTraceAttribute(marker, "outcome") != "admitted" {
			t.Fatal("coalescing lost separate ancestry or reparented the existing RPC")
		}
		assertCacheTraceLink(t, marker, clients[0].SpanContext())
		firstMarker := cacheDecisionFor(t, recorder, firstRoot.SpanContext())
		if cacheTraceAttribute(firstMarker, "outcome") != "unavailable" || !firstMarker.EndTime().Before(clients[0].EndTime()) {
			t.Fatal("leader cancellation was hidden or extended until another request completed")
		}
	})
}

func TestResolveTraceBackgroundRefreshOwnsRootAndLinksTriggerDecision(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		recorder := recordCacheTraces(t)
		gate := make(chan struct{})
		var release sync.Once
		var calls atomic.Int64
		client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
			payload := cacheTestPayload(request)
			if calls.Add(1) == 2 {
				<-gate
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		client.SessionFeedCaughtUp(time.Now().Add(-4 * time.Second))
		warm, warmRoot := otel.Tracer("test").Start(context.Background(), "warm request")
		if _, err := client.Resolve(warm, "token"); err != nil {
			t.Fatal(err)
		}
		warmRoot.End()
		time.Sleep(5 * time.Second)
		trigger, triggerRoot := otel.Tracer("test").Start(context.Background(), "trigger request")
		if principal, err := client.Resolve(trigger, "token"); err != nil || !principal.ResolveCacheHit {
			t.Fatalf("refresh trigger did not use a valid hit: %v", err)
		}
		triggerRoot.End()
		synctest.Wait()
		time.Sleep(time.Second) // Proof becomes stale while the refresh is still active.
		join, joinRoot := otel.Tracer("test").Start(context.Background(), "joining request")
		joined := make(chan error, 1)
		go func() { _, err := client.Resolve(join, "token"); joined <- err }()
		synctest.Wait()
		release.Do(func() { close(gate) })
		if err := <-joined; err != nil {
			t.Fatal(err)
		}
		client.Close()
		joinRoot.End()
		var refresh sdktrace.ReadOnlySpan
		for _, span := range recorder.Ended() {
			if span.Name() == "gateway.identity.resolve.refresh" {
				refresh = span
			}
		}
		if calls.Load() != 2 || refresh == nil || refresh.Parent().IsValid() || refresh.SpanContext().TraceID() == triggerRoot.SpanContext().TraceID() {
			t.Fatal("background RPC lacks its own process-owned root")
		}
		triggerMarker := cacheDecisionFor(t, recorder, triggerRoot.SpanContext())
		assertCacheTraceLink(t, refresh, triggerMarker.SpanContext())
		var actual sdktrace.ReadOnlySpan
		for _, span := range cacheClientSpans(recorder) {
			if span.Parent().SpanID() == refresh.SpanContext().SpanID() {
				actual = span
			}
		}
		if actual == nil {
			t.Fatal("background root does not own the actual RPC")
		}
		marker := cacheDecisionFor(t, recorder, joinRoot.SpanContext())
		if cacheTraceAttribute(marker, "source") != "shared" {
			t.Fatal("request joining background work lost its own decision")
		}
		assertCacheTraceLink(t, marker, actual.SpanContext())
	})
}

func TestResolveTraceEveryFailureHasSafeEndedDecision(t *testing.T) {
	for _, scenario := range []struct{ name, outcome string }{
		{"inactive", "rejected"}, {"unauthenticated", "rejected"}, {"inactive_principal", "rejected"},
		{"malformed", "unavailable"}, {"transport", "unavailable"}, {"pre-cancelled", "unavailable"}, {"closed", "unavailable"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				recorder := recordCacheTraces(t)
				client := cacheTraceClient(t, 10*time.Second, func(request *http.Request) (*http.Response, error) {
					payload := cacheTestPayload(request)
					switch scenario.name {
					case "transport":
						return nil, errors.New("private-error-canary")
					case "inactive":
						payload["principal"].(map[string]any)["active"] = false
					case "unauthenticated", "inactive_principal":
						return jsonResponse(401, `{"code":"`+scenario.name+`","message":"private-error-canary"}`), nil
					case "malformed":
						payload["principal"] = nil
					}
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				ctx, root := otel.Tracer("test").Start(context.Background(), "failed request")
				if scenario.name == "pre-cancelled" {
					var cancel context.CancelFunc
					ctx, cancel = context.WithCancel(ctx)
					cancel()
				}
				if scenario.name == "closed" {
					client.Close()
				}
				_, _ = client.Resolve(ctx, "private-browser-canary")
				root.End()
				marker := cacheDecisionFor(t, recorder, root.SpanContext())
				if cacheTraceAttribute(marker, "outcome") != scenario.outcome {
					t.Fatalf("wrong decision outcome: %v", marker.Attributes())
				}
				assertCacheTracePrivacy(t, recorder, "private-error-canary", "private-browser-canary", cacheTestSID("private-browser-canary"))
			})
		})
	}
}
