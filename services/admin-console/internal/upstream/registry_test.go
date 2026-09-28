package upstream

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRegistryClientUsesOnlyServiceTokenAndNeverRedirects(t *testing.T) {
	const token = "local-skill-registry-token-000000000000"
	requests := 0
	client, err := NewRegistryClient("http://registry.internal", token, &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Host != "registry.internal" || request.URL.Path != "/internal/skills" || request.URL.Query().Get("organization_id") != "org-1" {
			t.Fatalf("URL=%s", request.URL)
		}
		if request.Header.Get("Authorization") != "Bearer "+token || request.Header.Get("Cookie") != "" || request.Header.Get("X-Antnest-User-ID") != "" {
			t.Fatalf("unexpected headers: %v", request.Header)
		}
		return &http.Response{StatusCode: 307, Header: http.Header{"Location": []string{"http://unexpected.internal/"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(context.Background(), "GET", "/internal/skills", "organization_id=org-1", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if requests != 1 || response.StatusCode != 307 {
		t.Fatalf("requests=%d status=%d", requests, response.StatusCode)
	}
}

func TestRegistryClientRejectsInvalidConfigurationAndPaths(t *testing.T) {
	for _, value := range []struct{ url, token string }{{"file:///etc/passwd", "long-long-long-long-long-long-long-long"}, {"http://registry.internal", "short"}} {
		if _, err := NewRegistryClient(value.url, value.token, &http.Client{}); err == nil {
			t.Fatalf("accepted %+v", value)
		}
	}
	client, err := NewRegistryClient("http://registry.internal", "local-skill-registry-token-000000000000", &http.Client{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(context.Background(), "GET", "/internal/../admin", "", "", nil); err == nil {
		t.Fatal("accepted path traversal")
	}
}
