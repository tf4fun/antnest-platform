package registry

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestHTTPResponsesMatchRegistryContract(t *testing.T) {
	const schemaID = "https://antnest.local/contracts/skill-registry/registry-api.schema.json"
	data, err := os.ReadFile("../../../../contracts/skill-registry/registry-api.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(schemaID, document); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"create_metadata", "append_metadata", "version", "skill", "reference", "resolve_request", "resolve_response", "skill_page", "version_page", "error"} {
		if _, err := compiler.Compile(schemaID + "#/$defs/" + name); err != nil {
			t.Fatalf("compile %s: %v", name, err)
		}
	}
	assertSchema := func(name string, body []byte) {
		t.Helper()
		shape, err := compiler.Compile(schemaID + "#/$defs/" + name)
		if err != nil {
			t.Fatal(err)
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err := shape.Validate(value); err != nil {
			t.Fatalf("%s response violates schema: %v\n%s", name, err, body)
		}
	}
	handler := NewHandler(NewService(&memoryStore{}), testToken, nil)
	published := httptest.NewRecorder()
	handler.ServeHTTP(published, publishRequest(t,
		map[string]any{"request_id": "schema-1", "organization_id": testOrg, "actor_id": testActor},
		skillZIP(t, "---\nname: code-review\ndescription: Helpful review\n---\n")))
	if published.Code != http.StatusCreated {
		t.Fatalf("publish: %d %s", published.Code, published.Body.String())
	}
	assertSchema("version", published.Body.Bytes())
	var value Version
	if err := json.Unmarshal(published.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	listRequest := httptest.NewRequest(http.MethodGet, "/internal/skills?organization_id="+testOrg, nil)
	listRequest.Header.Set("Authorization", "Bearer "+testToken)
	listed := httptest.NewRecorder()
	handler.ServeHTTP(listed, listRequest)
	if listed.Code != http.StatusOK {
		t.Fatalf("list: %d %s", listed.Code, listed.Body.String())
	}
	assertSchema("skill_page", listed.Body.Bytes())
	resolveBody, _ := json.Marshal(map[string]any{"organization_id": testOrg,
		"refs": []Reference{{SkillID: value.SkillID, Version: 1}}})
	resolveRequest := httptest.NewRequest(http.MethodPost, "/internal/skill-versions/resolve", bytes.NewReader(resolveBody))
	resolveRequest.Header.Set("Authorization", "Bearer "+testToken)
	resolved := httptest.NewRecorder()
	handler.ServeHTTP(resolved, resolveRequest)
	if resolved.Code != http.StatusOK {
		t.Fatalf("resolve: %d %s", resolved.Code, resolved.Body.String())
	}
	assertSchema("resolve_response", resolved.Body.Bytes())
	errorResponse := httptest.NewRecorder()
	handler.ServeHTTP(errorResponse, httptest.NewRequest(http.MethodGet, "/internal/skills?organization_id="+testOrg, nil))
	assertSchema("error", errorResponse.Body.Bytes())
}
