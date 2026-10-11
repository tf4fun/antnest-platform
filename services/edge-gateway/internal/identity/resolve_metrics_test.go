package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

const resolveMetricPrefix = "antnest.gateway.identity.resolve."

func recordResolveMetrics(t *testing.T) *sdkmetric.ManualReader {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		otel.SetMeterProvider(previous)
	})
	return reader
}

func collectResolveMetrics(t *testing.T, reader *sdkmetric.ManualReader) map[string]metricdata.Metrics {
	t.Helper()
	var resource metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &resource); err != nil {
		t.Fatal(err)
	}
	result := map[string]metricdata.Metrics{}
	for _, scope := range resource.ScopeMetrics {
		for _, metric := range scope.Metrics {
			result[metric.Name] = metric
		}
	}
	return result
}

func resolveMetricCount(metrics map[string]metricdata.Metrics, name, source, outcome string) int64 {
	sum, _ := metrics[resolveMetricPrefix+name].Data.(metricdata.Sum[int64])
	var result int64
	for _, point := range sum.DataPoints {
		if metricLabel(point.Attributes, "outcome") == outcome && (source == "" || metricLabel(point.Attributes, "source") == source) {
			result += point.Value
		}
	}
	return result
}

func metricLabel(attributes attribute.Set, key string) string {
	value, _ := attributes.Value(attribute.Key(key))
	return value.AsString()
}

func assertResolveGauge(t *testing.T, metrics map[string]metricdata.Metrics, suffix string, want int64) {
	t.Helper()
	gauge, _ := metrics[resolveMetricPrefix+"cache."+suffix].Data.(metricdata.Gauge[int64])
	if len(gauge.DataPoints) != 1 || gauge.DataPoints[0].Value != want || gauge.DataPoints[0].Attributes.Len() != 0 {
		t.Fatalf("%s gauge = %+v, want %d without authority labels", suffix, gauge, want)
	}
}

func TestResolveMetricsCountRPCSeparatelyFromSharedAndCachedDecisions(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		reader := recordResolveMetrics(t)
		gate := make(chan struct{})
		var release sync.Once
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
			payload := cacheTestPayload(request)
			if calls.Add(1) == 1 {
				<-gate
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		client.SessionFeedCaughtUp(time.Now())
		done := make(chan error, 2)
		for range 2 {
			go func() { _, err := client.Resolve(context.Background(), "private-token-canary"); done <- err }()
			synctest.Wait()
		}
		time.Sleep(100 * time.Millisecond)
		release.Do(func() { close(gate) })
		for range 2 {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		principal, err := client.Resolve(context.Background(), "private-token-canary")
		if err != nil || !principal.ResolveCacheHit {
			t.Fatalf("expected a cache hit: %v", err)
		}
		metrics := collectResolveMetrics(t, reader)
		for _, source := range []string{"rpc", "shared", "cache"} {
			if resolveMetricCount(metrics, "decisions", source, "admitted") != 1 {
				t.Fatalf("missing separate %s admission count", source)
			}
		}
		if resolveMetricCount(metrics, "rpc.calls", "", "admitted") != 1 {
			t.Fatal("RPC counter is absent or counted shared/cache decisions as RPCs")
		}
		histogram, _ := metrics[resolveMetricPrefix+"rpc.duration"].Data.(metricdata.Histogram[float64])
		if len(histogram.DataPoints) != 1 || histogram.DataPoints[0].Count != 1 || histogram.DataPoints[0].Sum != 0.1 || metrics[resolveMetricPrefix+"rpc.duration"].Unit != "s" {
			t.Fatalf("actual RPC duration was missing, duplicated or excluded its response wait: %+v", histogram)
		}
		time.Sleep(5 * time.Second)
		if _, err := client.Resolve(context.Background(), "private-token-canary"); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		metrics = collectResolveMetrics(t, reader)
		if calls.Load() != 2 || resolveMetricCount(metrics, "rpc.calls", "", "admitted") != 2 || resolveMetricCount(metrics, "decisions", "cache", "admitted") != 2 {
			t.Fatal("background refresh was omitted or counted as another request decision")
		}
		encoded, err := json.Marshal(metrics)
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{"private-token-canary", principal.SessionID, principal.CallerContext, "user-1", "org-1"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatal("private authority appeared in metric data")
			}
		}
	})
}

func TestResolveMetricsIncludeFailuresAndDoNotCountPreCancelledRPC(t *testing.T) {
	for _, scenario := range []struct{ name, outcome string }{
		{"inactive", "rejected"}, {"unauthenticated", "rejected"}, {"malformed", "unavailable"},
		{"transport", "unavailable"}, {"pre-cancelled", "unavailable"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				reader := recordResolveMetrics(t)
				client := cachedTestClient(t, 0, 100, func(request *http.Request) (*http.Response, error) {
					payload := cacheTestPayload(request)
					switch scenario.name {
					case "inactive":
						payload["principal"].(map[string]any)["active"] = false
					case "unauthenticated":
						return jsonResponse(401, `{"code":"unauthenticated","message":"private-error-canary"}`), nil
					case "malformed":
						payload["principal"] = nil
					case "transport":
						return nil, errors.New("private-error-canary")
					}
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if scenario.name == "pre-cancelled" {
					cancel()
				}
				_, _ = client.Resolve(ctx, "token")
				metrics := collectResolveMetrics(t, reader)
				wantRPC := int64(1)
				if scenario.name == "pre-cancelled" {
					wantRPC = 0
				}
				if resolveMetricCount(metrics, "decisions", "rpc", scenario.outcome) != 1 || resolveMetricCount(metrics, "rpc.calls", "", scenario.outcome) != wantRPC {
					t.Fatal("failed outcome was lost or an unattempted RPC was counted")
				}
			})
		})
	}
}

func TestResolveMetricsObserveLiveCapacityAndAgingProofAndUnregisterOnClose(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		reader := recordResolveMetrics(t)
		gate := make(chan struct{})
		var release sync.Once
		client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
			payload := cacheTestPayload(request)
			<-gate
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		metrics := collectResolveMetrics(t, reader)
		assertResolveGauge(t, metrics, "proof.available", 0)
		assertResolveGauge(t, metrics, "proof.fresh", 0)
		if _, ok := metrics[resolveMetricPrefix+"cache.proof.age"]; ok {
			t.Fatal("missing proof was misreported as zero age")
		}
		client.SessionFeedCaughtUp(time.Now())
		done := make(chan error, 2)
		for range 2 {
			go func() { _, err := client.Resolve(context.Background(), "token"); done <- err }()
			synctest.Wait()
		}
		metrics = collectResolveMetrics(t, reader)
		assertResolveGauge(t, metrics, "work", 1)
		assertResolveGauge(t, metrics, "waiters", 2)
		assertResolveGauge(t, metrics, "entries", 0)
		assertResolveGauge(t, metrics, "accounted_bytes", 0)
		release.Do(func() { close(gate) })
		for range 2 {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		metrics = collectResolveMetrics(t, reader)
		assertResolveGauge(t, metrics, "work", 0)
		assertResolveGauge(t, metrics, "waiters", 0)
		assertResolveGauge(t, metrics, "entries", 1)
		bytes, _ := metrics[resolveMetricPrefix+"cache.accounted_bytes"].Data.(metricdata.Gauge[int64])
		if len(bytes.DataPoints) != 1 || bytes.DataPoints[0].Value <= 1024 || bytes.DataPoints[0].Value > 16<<10 {
			t.Fatal("accounted bytes omitted retained authority or confused entry budget with process RSS")
		}
		time.Sleep(10 * time.Second)
		metrics = collectResolveMetrics(t, reader)
		assertResolveGauge(t, metrics, "proof.available", 1)
		assertResolveGauge(t, metrics, "proof.fresh", 0)
		age, _ := metrics[resolveMetricPrefix+"cache.proof.age"].Data.(metricdata.Gauge[float64])
		if len(age.DataPoints) != 1 || age.DataPoints[0].Value != 10 || metrics[resolveMetricPrefix+"cache.proof.age"].Unit != "s" {
			t.Fatal("idle feed outage left a falsely fresh/zero proof age")
		}
		client.Close()
		for name := range collectResolveMetrics(t, reader) {
			if strings.HasPrefix(name, resolveMetricPrefix+"cache.") {
				t.Fatal("closed client retained an observable callback or stale cache measurements")
			}
		}
	})
}

func TestResolveMetricsReplacementClientAndDisabledCacheDoNotRetainOldCallback(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		reader := recordResolveMetrics(t)
		for _, ttl := range []time.Duration{10 * time.Second, 0, 10 * time.Second} {
			client := cachedTestClient(t, ttl, 100, func(request *http.Request) (*http.Response, error) {
				return cacheTestResponse(cacheTestPayload(request)), nil
			})
			if _, err := client.Resolve(context.Background(), "token"); err != nil {
				t.Fatal(err)
			}
			metrics := collectResolveMetrics(t, reader)
			if ttl > 0 {
				assertResolveGauge(t, metrics, "entries", 1)
			} else if _, found := metrics[resolveMetricPrefix+"cache.entries"]; found {
				t.Fatal("TTL zero retained the preceding client's callback")
			}
			client.Close()
			client.Close()
			if _, found := collectResolveMetrics(t, reader)[resolveMetricPrefix+"cache.entries"]; found {
				t.Fatal("repeated Close left a cache registration")
			}
		}
	})
}

func TestResolveMetricsConcurrentCollectionAndClose(t *testing.T) {
	reader := recordResolveMetrics(t)
	client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
		return cacheTestResponse(cacheTestPayload(request)), nil
	})
	defer client.Close()
	client.SessionFeedCaughtUp(time.Now())
	if _, err := client.Resolve(context.Background(), "token"); err != nil {
		t.Fatal(err)
	}
	started, stopped := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		for range 100 {
			var resource metricdata.ResourceMetrics
			if err := reader.Collect(context.Background(), &resource); err != nil {
				stopped <- err
				return
			}
		}
		stopped <- nil
	}()
	<-started
	client.Close()
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
}
