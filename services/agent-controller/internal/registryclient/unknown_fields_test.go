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

func TestResolveToleratesUnknownResponseFields(t *testing.T) {
	t.Parallel()
	transport := transportFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/internal/skill-versions/resolve" {
			t.Fatalf("wrong Registry request path: %s", request.URL.Path)
		}
		body := `{"items":[{` +
			`"skill_id":"skill_11111111111111111111111111111111","version":2,` +
			`"name":"search-docs","description":"synthetic golden fixture",` +
			`"artifact_digest":"sha256:` + strings.Repeat("a", 64) + `",` +
			`"content_digest":"sha256:` + strings.Repeat("b", 64) + `",` +
			`"artifact_size":128,"unpacked_size":256,"package_rules_version":1,` +
			`"future_extension":{"nested":[1,2]}` +
			`}],"future_top":{"cursor":"opaque"}}`
		return &http.Response{
			StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(body)),
		}, nil
	})
	client, err := New("http://registry:8080", time.Second, transport)
	if err != nil {
		t.Fatal(err)
	}
	items, err := client.Resolve(context.Background(), "org-1",
		[]domain.SkillReference{{SkillID: "skill_11111111111111111111111111111111", Version: 2}})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("resolve items = %+v", items)
	}
	if items[0].SkillID != "skill_11111111111111111111111111111111" || items[0].Version != 2 ||
		items[0].Name != "search-docs" {
		t.Fatalf("resolved skill = %+v", items[0])
	}
}
