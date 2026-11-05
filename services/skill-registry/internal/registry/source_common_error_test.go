package registry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/apierror"
)

func serveBody(t *testing.T, status int, body string) *HTTPAgentSource {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	source, err := NewHTTPAgentSource(server.URL, server.Client())
	if err != nil {
		t.Fatalf("NewHTTPAgentSource: %v", err)
	}
	return source
}

func artifactErr(t *testing.T, source *HTTPAgentSource) error {
	t.Helper()
	_, err := source.Artifact(context.Background(), SourceArtifactInput{})
	if err == nil {
		t.Fatal("expected artifact error")
	}
	return err
}

const oldNested = `{"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`
const newCommon = `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1"}`
const newCommonAlias = `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`
const newCommonAliasDetails = `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","details":{"attempt":1},"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`

func TestCommonSourceErrorContentChanged(t *testing.T) {
	for name, body := range map[string]string{
		"legacy nested only":    oldNested,
		"new flat five":         newCommon,
		"new five plus alias":   newCommonAlias,
		"new five plus details": newCommonAliasDetails,
	} {
		t.Run(name, func(t *testing.T) {
			source := serveBody(t, 409, body)
			err := artifactErr(t, source)
			if code := Code(err); code != apierror.ContentChanged {
				t.Fatalf("expected %s, got %v", apierror.ContentChanged, err)
			}
			if strings.Contains(err.Error(), "private-canary") {
				t.Fatal("public error must not reflect private cause")
			}
		})
	}
}

func TestCommonSourceErrorRejections(t *testing.T) {
	for name, body := range map[string]string{
		"partial missing category":   `{"code":"content_changed","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"partial missing request_id": `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"unknown category":           `{"code":"content_changed","category":"bogus","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"wrong category":             `{"code":"content_changed","category":"internal","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"missing retryable":          `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"retryable true":             `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":true,"request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"unsafe request id":          `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"bad id with spaces","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"alias code mismatch":        `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":{"code":"other","message":"Skill source content changed; choose again"}}`,
		"alias message mismatch":     `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":{"code":"content_changed","message":"different"}}`,
		"unknown top extra":          `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","cause":"private-canary","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"unknown nested extra":       `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again","cause":"private-canary"}}`,
		"details non-object":         `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","details":"private-canary","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"common null fields":         `{"code":"content_changed","category":null,"message":"Skill source content changed; choose again","retryable":false,"request_id":null,"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"unrelated code":             `{"code":"other_code","category":"conflict","message":"x","retryable":false,"request_id":"req-1","error":{"code":"other_code","message":"x"}}`,
		"legacy with private extra":  `{"error":{"code":"content_changed","message":"Skill source content changed; choose again","cause":"private-canary"}}`,
		"duplicate json member":      `{"error":{"code":"content_changed","message":"Skill source content changed; choose again"},"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"details null":               `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","details":null,"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"retryable null":             `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":null,"request_id":"req-1","error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"all five null plus alias":   `{"code":null,"category":null,"message":null,"retryable":null,"request_id":null,"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}`,
		"alias null":                 `{"code":"content_changed","category":"conflict","message":"Skill source content changed; choose again","retryable":false,"request_id":"req-1","error":null}`,
		"oversized valid legacy":     `{"error":{"code":"content_changed","message":"Skill source content changed; choose again"}}` + strings.Repeat(" ", 5000),
	} {
		t.Run(name, func(t *testing.T) {
			source := serveBody(t, 409, body)
			err := artifactErr(t, source)
			if code := Code(err); code != apierror.SourceUnavailable {
				t.Fatalf("expected %s, got %v", apierror.SourceUnavailable, err)
			}
			if strings.Contains(err.Error(), "private-canary") {
				t.Fatal("public error must not reflect private cause")
			}
		})
	}
}
