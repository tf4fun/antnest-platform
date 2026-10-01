package registry

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDiscoveryHTTPRejectsContentProjectionAndRequiresActor(t *testing.T) {
	d, store, _, source, load := discoveryFixture(t)
	h := NewHandler(NewService(store), testToken, nil, d)
	request := func(path string, in any, token string) *httptest.ResponseRecorder {
		t.Helper()
		body, _ := json.Marshal(in)
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		req.Header.Set("Authorization", token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	bad, _ := json.Marshal(source.current)
	var metadata map[string]any
	_ = json.Unmarshal(bad, &metadata)
	metadata["artifact"] = "ZIP"
	req := httptest.NewRequest(http.MethodPut, "/internal/skill-projections", bytes.NewReader(mustJSON(t, metadata)))
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("projected bytes accepted: %d %s", rec.Code, rec.Body.String())
	}
	search := SearchInput{OrganizationID: testOrg, ActorID: testActor, Query: "review"}
	if rec := request("/internal/skill-discovery/search", search, ""); rec.Code != 401 {
		t.Fatalf("unauthenticated search: %d", rec.Code)
	}
	if rec := request("/internal/skill-discovery/search", search, "Bearer "+testToken); rec.Code != 200 {
		t.Fatalf("search: %d %s", rec.Code, rec.Body.String())
	}
	if rec := request("/internal/skill-discovery/load", load, "Bearer "+testToken); rec.Code != 200 || rec.Header().Get("X-Antnest-Content-Digest") != load.ExpectedDigest || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("load: %d %v", rec.Code, rec.Header())
	}
	if rec := request("/internal/skill-discovery/search", map[string]any{"organization_id": testOrg, "actor_id": testActor, "query": "review", "limit": 0}, "Bearer "+testToken); rec.Code != 400 {
		t.Fatalf("explicit zero limit: %d", rec.Code)
	}
	in := PromoteInput{RequestID: "http-promote", OrganizationID: testOrg, ActorID: testActor, SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest}
	if rec := request("/internal/skill-projections/promote", in, "Bearer "+testToken); rec.Code != 201 {
		t.Fatalf("promote: %d %s", rec.Code, rec.Body.String())
	}
}
func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	out, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDiscoveryHTTPCallerSearchKeepsFormalResultsWithoutInspectingBusyCaller(t *testing.T) {
	d, store, _, source, load := discoveryFixture(t)
	published, err := d.Promote(t.Context(), PromoteInput{
		RequestID: "caller-promote", OrganizationID: testOrg, ActorID: testActor,
		SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest,
	})
	if err != nil {
		t.Fatal(err)
	}
	source.err = failure("source_unavailable", "the foreground caller is busy")
	handler := NewHandler(NewService(store), testToken, nil, d)
	invoke := func(input map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/internal/skill-discovery/search", bytes.NewReader(mustJSON(t, input)))
		req.Header.Set("Authorization", "Bearer "+testToken)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	input := map[string]any{"organization_id": testOrg, "actor_id": testActor, "query": "review", "limit": 1}
	if response := invoke(input); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("ordinary owner search must retain unavailable-source semantics: %d", response.Code)
	}
	input["requesting_agent_id"] = testAgent
	response := invoke(input)
	if response.Code != http.StatusOK {
		t.Fatalf("caller search: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Items []DiscoveryItem `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].SkillRef.Kind != "registry" || result.Items[0].SkillRef.SkillID != published.SkillID {
		t.Fatalf("formal versions must survive excluding their current source Agent: %+v", result.Items)
	}
	for _, caller := range []any{nil, "", testActor, "agent", 1} {
		input["requesting_agent_id"] = caller
		if response := invoke(input); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid caller %v accepted: %d", caller, response.Code)
		}
	}
}
