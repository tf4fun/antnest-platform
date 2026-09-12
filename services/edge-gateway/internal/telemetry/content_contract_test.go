package telemetry

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPNeverCollectsContent(t *testing.T) {
	for _, media := range []string{"application/json", "text/event-stream", "application/octet-stream"} {
		t.Run(media, func(t *testing.T) {
			recorder := recordHTTPSpans(t)
			body := `{"organization_slug":"content-canary","password":"content-canary"}`
			mux := http.NewServeMux()
			mux.HandleFunc("POST /api/session/login", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", media)
				w.Header().Set("Set-Cookie", "content-canary")
				if _, err := io.Copy(w, r.Body); err != nil {
					t.Error(err)
				}
			})
			request := httptest.NewRequest("POST", "/api/session/login", strings.NewReader(body))
			request.Header.Set("Content-Type", media)
			request.Header.Set("Authorization", "Bearer content-canary")
			response := httptest.NewRecorder()
			HTTPHandler(mux, nil).ServeHTTP(response, request)
			if response.Body.String() != body || response.Header().Get("Set-Cookie") != "content-canary" {
				t.Fatal("observability changed the response")
			}
			spans := recorder.Ended()
			if len(spans) != 1 {
				t.Fatalf("spans=%d", len(spans))
			}
			assertNoTraceValue(t, spans, "content-canary")
			for _, event := range spans[0].Events() {
				if event.Name == "antnest.request" || event.Name == "antnest.response" {
					t.Fatal("plain HTTP must not have payload events")
				}
			}
		})
	}
}
