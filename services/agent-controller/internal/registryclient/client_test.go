package registryclient

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (fn transportFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func TestResolveUsesServiceTokenAndExactOrganization(t *testing.T) {
	t.Parallel()
	transport := transportFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/internal/skill-versions/resolve" || request.Header.Get("Authorization") != "Bearer service-token" {
			t.Fatalf("wrong Registry request: %+v", request)
		}
		body, _ := io.ReadAll(request.Body)
		if !strings.Contains(string(body), `"organization_id":"org-1"`) || !strings.Contains(string(body), `"version":2`) {
			t.Fatalf("wrong Registry payload: %s", body)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"items":[]}`)), Header: make(http.Header)}, nil
	})
	client, err := New("http://registry:8080", "service-token", time.Second, transport)
	if err != nil {
		t.Fatal(err)
	}
	items, err := client.Resolve(context.Background(), "org-1", []domain.SkillReference{{SkillID: "skill_11111111111111111111111111111111", Version: 2}})
	if err != nil || len(items) != 0 {
		t.Fatalf("resolve = %+v, %v", items, err)
	}
}
