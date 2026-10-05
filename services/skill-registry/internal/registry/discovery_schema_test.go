package registry

import (
	"bytes"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDiscoveryHTTPResponsesMatchSharedSchemaAndRejectMixedAuthority(t *testing.T) {
	compiler := jsonschema.NewCompiler()
	for _, name := range []string{"registry-api", "discovery-api"} {
		data, err := os.ReadFile("../../../../contracts/skill-registry/" + name + ".schema.json")
		if err != nil {
			t.Fatal(err)
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if err := compiler.AddResource("https://antnest.local/contracts/skill-registry/"+name+".schema.json", value); err != nil {
			t.Fatal(err)
		}
	}
	check := func(name string, data []byte) {
		t.Helper()
		schema, err := compiler.Compile("https://antnest.local/contracts/skill-registry/discovery-api.schema.json#/$defs/" + name)
		if err != nil {
			t.Fatal(err)
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(value); err != nil {
			t.Fatalf("%s response: %v", name, err)
		}
	}
	d, store, _, source, load := discoveryFixture(t)
	handler := newTestHandler(t, NewService(store), d)
	invoke := func(method, path string, value any) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(mustJSON(t, value)))
		handler.Authenticate(req)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	update := invoke(http.MethodPut, "/internal/skill-projections", source.current)
	if update.Code != 200 {
		t.Fatal(update.Code)
	}
	check("projection_result", update.Body.Bytes())
	found := invoke(http.MethodPost, "/internal/skill-discovery/search", SearchInput{OrganizationID: testOrg, ActorID: testActor, Query: "review"})
	if found.Code != 200 {
		t.Fatal(found.Code)
	}
	check("search_response", found.Body.Bytes())
	published := invoke(http.MethodPost, "/internal/skill-projections/promote", PromoteInput{RequestID: "schema-promote", OrganizationID: testOrg, ActorID: testActor, SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest})
	if published.Code != 201 {
		t.Fatal(published.Body.String())
	}
	check("version", published.Body.Bytes())
	source.err = failure("source_unavailable", "PRIVATE_SOURCE_SECRET")
	unavailable := invoke(http.MethodPost, "/internal/skill-discovery/load", load)
	if unavailable.Code != 503 || strings.Contains(unavailable.Body.String(), "PRIVATE_SOURCE_SECRET") {
		t.Fatal("source error leaked or was reclassified")
	}
	check("error", unavailable.Body.Bytes())
	for _, input := range []map[string]any{
		{"organization_id": testOrg, "actor_id": testActor, "expected_digest": load.ExpectedDigest, "skill_ref": map[string]any{"kind": "agent", "agent_id": testAgent, "name": "code-review", "sequence": 1, "version": 0}},
		{"organization_id": testOrg, "actor_id": testActor, "expected_digest": load.ExpectedDigest, "skill_ref": load.SkillRef, "source_url": "http://arbitrary"},
	} {
		rejected := invoke(http.MethodPost, "/internal/skill-discovery/load", input)
		if rejected.Code != 400 {
			t.Fatalf("mixed/extra authority accepted: %d", rejected.Code)
		}
		check("error", rejected.Body.Bytes())
	}
	projectionBody := map[string]any{"organization_id": testOrg, "agent_id": testAgent, "owner_id": testActor, "name": "code-review", "description": "Review code", "sequence": 3, "content_digest": load.ExpectedDigest, "active": nil}
	if rejected := invoke(http.MethodPut, "/internal/skill-projections", projectionBody); rejected.Code != 400 {
		t.Fatal("null active removed mapping")
	}
}
