package registry

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func TestRegistryHTTPServerPreservesParentAndUsesRouteTemplate(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder, ctx, caller := sourceSpans(t)
	d, store, _, _, _ := discoveryFixture(t)
	h := newTestHandler(t, NewService(store), d)
	req := httptest.NewRequest(http.MethodGet, "/internal/skills/skill_00000000000000000000000000000001/versions/1/artifact?organization_id="+testOrg+"&private-query=secret", nil)
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(req.Header))
	h.Authenticate(req)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("missing skill response changed: %d", rec.Code)
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].SpanKind() != trace.SpanKindServer || spans[0].Name() != "HTTP GET /internal/skills/{skill_id}/versions/{version}/artifact" || spans[0].Parent().SpanID() != caller.SpanContext().SpanID() || spans[0].SpanContext().TraceID() != caller.SpanContext().TraceID() {
		t.Fatalf("missing template SERVER child: %v", spans)
	}
	if spans[0].Status().Code != codes.Unset || len(spans[0].Events()) != 0 {
		t.Fatal("normal 404 became an execution error or content event")
	}
}

func TestRegistryHTTPUnauthorizedAndUnmatchedRequestsRemainObservable(t *testing.T) {
	for _, path := range []string{"/internal/skills", "/unregistered/private-value"} {
		t.Run(path, func(t *testing.T) {
			recorder, _, _ := sourceSpans(t)
			h := newTestHandler(t, NewService(&memoryStore{}))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			spans := recorder.Ended()
			if len(spans) != 1 || spans[0].SpanKind() != trace.SpanKindServer {
				t.Fatalf("missing rejected HTTP span: %v", spans)
			}
			expected := "HTTP GET /internal/skills"
			if path == "/unregistered/private-value" {
				expected = "HTTP GET unmatched"
			}
			if rec.Code == 404 {
				expected = "HTTP GET unmatched"
			} else if rec.Code != 401 {
				t.Fatalf("changed rejection status: %d", rec.Code)
			}
			if spans[0].Name() != expected {
				t.Fatalf("unbounded/rejected route name: %s", spans[0].Name())
			}
		})
	}
}
