package upstream

import (
	"context"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/callercontext"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRegistryClientForwardsOnlyVerifiedContextAndNeverRedirects(t *testing.T) {
	const token = "verified-context"
	requests := 0
	client, err := NewRegistryClient("http://registry.internal", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Host != "registry.internal" || request.URL.Path != "/internal/skills" || request.URL.Query().Get("organization_id") != "org-1" {
			t.Fatalf("URL=%s", request.URL)
		}
		if request.Header.Get("Authorization") != "" || request.Header.Get(callercontext.Header) != token || request.Header.Get("Cookie") != "" || request.Header.Get("X-Antnest-User-ID") != "" {
			t.Fatalf("unexpected headers: %v", request.Header)
		}
		return &http.Response{StatusCode: 307, Header: http.Header{"Location": []string{"http://unexpected.internal/"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(callercontext.WithToken(context.Background(), token), "GET", "/internal/skills", "organization_id=org-1", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if requests != 1 || response.StatusCode != 307 {
		t.Fatalf("requests=%d status=%d", requests, response.StatusCode)
	}
}

func TestRegistryClientRejectsInvalidConfigurationAndPaths(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "http://user:pass@registry.internal"} {
		if _, err := NewRegistryClient(raw, &http.Client{}); err == nil {
			t.Fatal("accepted invalid Registry URL")
		}
	}
	if _, err := NewRegistryClient("http://registry.internal", nil); err == nil {
		t.Fatal("accepted missing transport")
	}
	client, err := NewRegistryClient("http://registry.internal", &http.Client{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(context.Background(), "GET", "/internal/../admin", "", "", nil); err == nil {
		t.Fatal("accepted path traversal")
	}
}
