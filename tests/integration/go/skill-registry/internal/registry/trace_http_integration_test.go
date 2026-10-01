package registry

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/skill-registry/internal/telemetry"
)

func TestRegistryRealHTTPSourceSearchAndLoadKeepCompleteNativeParents(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder, ctx, caller := sourceSpans(t)
	_, store, index, fixture, selected := discoveryFixture(t)
	sourceMux := http.NewServeMux()
	observe := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("source authentication changed")
			w.WriteHeader(401)
			return false
		}
		_, span := otel.Tracer("source-fixture").Start(r.Context(), "skill.source.observe", trace.WithAttributes(attribute.String("antnest.agent_id", testAgent)))
		span.End()
		return true
	}
	sourceMux.HandleFunc("POST /internal/skill-sources/inspect", func(w http.ResponseWriter, r *http.Request) {
		if !observe(w, r) {
			return
		}
		var in struct {
			OrganizationID string      `json:"organization_id"`
			ActorID        string      `json:"actor_id"`
			Sources        []SourceKey `json:"sources"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.OrganizationID != testOrg || in.ActorID != testActor || len(in.Sources) != 1 || in.Sources[0].AgentID != testAgent {
			t.Error("source inspection authority changed")
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []Projection{fixture.current}})
	})
	sourceMux.HandleFunc("POST /internal/skill-sources/artifact", func(w http.ResponseWriter, r *http.Request) {
		if !observe(w, r) {
			return
		}
		var in SourceArtifactInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in != selected {
			t.Error("source selection changed")
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Length", strconv.Itoa(len(fixture.archive)))
		w.Header().Set("X-Antnest-Source-Sequence", "1")
		w.Header().Set("X-Antnest-Content-Digest", selected.ExpectedDigest)
		w.Header().Set("X-Antnest-Artifact-Digest", digest(fixture.archive))
		_, _ = w.Write(fixture.archive)
	})
	sourceServer := httptest.NewServer(telemetry.HTTPHandler(sourceMux))
	defer sourceServer.Close()
	source, err := NewHTTPAgentSource(sourceServer.URL, testToken)
	if err != nil {
		t.Fatal(err)
	}
	d := NewDiscovery(NewService(store), index, source)
	server := httptest.NewServer(NewHandler(NewService(store), testToken, nil, d))
	defer server.Close()
	client := server.Client()
	defer client.CloseIdleConnections()
	for _, tc := range []struct {
		path  string
		input any
	}{
		{"search", SearchInput{OrganizationID: testOrg, ActorID: testActor, Query: "Review"}},
		{"load", selected},
	} {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/internal/skill-discovery/"+tc.path, bytes.NewReader(mustJSON(t, tc.input)))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+testToken)
		request.Header.Set("Content-Type", "application/json")
		propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("%s failed: %d %v", tc.path, response.StatusCode, err)
		}
		if tc.path == "search" {
			var result struct {
				Items []DiscoveryItem `json:"items"`
			}
			if err := json.Unmarshal(body, &result); err != nil || len(result.Items) != 1 || result.Items[0].SkillRef != selected.SkillRef {
				t.Fatal("HTTP search result changed")
			}
		} else if !bytes.Equal(body, fixture.archive) {
			t.Fatal("HTTP load changed exact package bytes")
		}
	}
	server.Close()
	sourceServer.Close()
	caller.End()
	spans := recorder.Ended()
	if len(spans) != 9 {
		t.Fatalf("expected caller, two Registry SERVERs, two CLIENTs, two source SERVERs and two observations, got %d", len(spans))
	}
	byID := map[trace.SpanID]trace.SpanKind{}
	for _, span := range spans {
		byID[span.SpanContext().SpanID()] = span.SpanKind()
	}
	clients, observations := 0, 0
	for _, span := range spans {
		if span.SpanContext().TraceID() != caller.SpanContext().TraceID() {
			t.Fatalf("separate source Trace: %s", span.Name())
		}
		if span.Parent().IsValid() {
			if _, ok := byID[span.Parent().SpanID()]; !ok {
				t.Fatalf("missing parent: %s", span.Name())
			}
		}
		if span.SpanKind() == trace.SpanKindClient {
			clients++
			if byID[span.Parent().SpanID()] != trace.SpanKindServer {
				t.Fatal("source CLIENT is not a child of Registry SERVER")
			}
		}
		if strings.Contains(span.Name(), "/internal/skill-sources/") && byID[span.Parent().SpanID()] != trace.SpanKindClient {
			t.Fatal("source SERVER is not a child of Registry CLIENT")
		}
		if span.Name() == "skill.source.observe" {
			observations++
			if byID[span.Parent().SpanID()] != trace.SpanKindServer {
				t.Fatal("source observation lost its SERVER parent")
			}
		}
		if len(span.Events()) != 0 {
			t.Fatal("HTTP captured a content event")
		}
	}
	if clients != 2 || observations != 2 {
		t.Fatal("source exchange/observation counts changed")
	}
}
