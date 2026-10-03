package providerdiscovery

import (
	"context"
	"errors"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/outbound"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDiscoveryNormalizesRemoteMetadata(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/models" || r.Header.Get("Authorization") != "Bearer synthetic-key" {
			t.Errorf("wrong discovery target or credential")
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"new/model","name":"New model","context_length":128000,"top_provider":{"max_completion_tokens":8192},"architecture":{"input_modalities":["text","image"]},"pricing":{"prompt":"0.00000015","completion":"0.0000006","input_cache_read":"0"}},{"id":"bare"},{"id":"bare"}]}`))
	}))
	defer upstream.Close()
	models, err := fixtureClient(t, time.Second).ListModels(context.Background(), Connection{ProviderKey: "openrouter", BaseURL: upstream.URL + "/api/v1/"}, "synthetic-key")
	if err != nil || len(models) != 2 {
		t.Fatalf("models=%+v error=%v", models, err)
	}
	model := models[0]
	if model.ContextWindow == nil || *model.ContextWindow != 128000 || model.MaxOutputTokens == nil || *model.MaxOutputTokens != 8192 || model.SupportsImages == nil || !*model.SupportsImages || model.Pricing == nil || model.Pricing.InputPerMillion == nil || *model.Pricing.InputPerMillion != 0.15 || model.Pricing.CacheReadPerMillion == nil || *model.Pricing.CacheReadPerMillion != 0 {
		t.Fatalf("metadata lost: %+v", model)
	}
	if models[1].Pricing != nil || models[1].ContextWindow != nil || models[1].DisplayName != "bare" {
		t.Fatal("invented metadata")
	}
}

func TestDiscoveryFailuresAreBoundedAndDoNotEchoSecrets(t *testing.T) {
	for _, body := range []string{`{}`, `{"data":null}`, `{"data":[{}]}`, `{"data":[]} trailing`, strings.Repeat("x", maximumResponseBytes+1)} {
		t.Run(body[:min(len(body), 20)], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }))
			defer upstream.Close()
			_, err := fixtureClient(t, time.Second).ListModels(context.Background(), Connection{ProviderKey: "deepseek", BaseURL: upstream.URL}, "synthetic-key")
			if err == nil || strings.Contains(err.Error(), "synthetic-key") {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestDiscoveryEmptySuccessAndHTTPFailure(t *testing.T) {
	for _, status := range []int{200, 401, 429, 500, 302} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Location", "/other")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"data":[],"error":"synthetic-key"}`))
			}))
			defer upstream.Close()
			models, err := fixtureClient(t, time.Second).ListModels(context.Background(), Connection{ProviderKey: "deepseek", BaseURL: upstream.URL}, "synthetic-key")
			if status == 200 {
				if err != nil || models == nil || len(models) != 0 {
					t.Fatalf("empty success: %+v %v", models, err)
				}
			} else if err == nil || strings.Contains(err.Error(), "synthetic-key") {
				t.Fatalf("unsafe/missing error: %v", err)
			}
			if calls != 1 {
				t.Fatal("retried or followed credential redirect")
			}
		})
	}
}

func TestDiscoveryTimeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer upstream.Close()
	_, err := fixtureClient(t, 20*time.Millisecond).ListModels(context.Background(), Connection{ProviderKey: "deepseek", BaseURL: upstream.URL}, "key")
	if err == nil {
		t.Fatal("missing deadline")
	}
}

func TestDiscoveryIgnoresUnrelatedPricingExtensions(t *testing.T) {
	models, err := decodeModels([]byte(`{"data":[{"id":"model","pricing":{"prompt":"0.000001","completion":"0.000002","overrides":{"region":{"prompt":"0.000003"}}}}]}`))
	if err != nil || len(models) != 1 || models[0].Pricing == nil || *models[0].Pricing.InputPerMillion != 1 {
		t.Fatalf("pricing extension broke model discovery: %v", err)
	}
}

func fixtureClient(t *testing.T, timeout time.Duration) *Client {
	t.Helper()
	client := New(timeout, outbound.NewPolicy(true))
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func TestDefaultDiscoveryRejectsPrivateTargetBeforeSendingCredential(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(200) }))
	defer upstream.Close()
	client := New(time.Second, outbound.NewPolicy(false))
	defer client.CloseIdleConnections()
	_, err := client.ListModels(t.Context(), Connection{ProviderKey: "deepseek", BaseURL: upstream.URL}, "synthetic-key")
	if !errors.Is(err, ports.ErrProviderEndpointForbidden) || calls != 0 {
		t.Fatalf("private target sent credentials: %v calls=%d", err, calls)
	}
}
