package registry

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestHTTPResponsesMatchRegistryContract(t *testing.T) {
	const schemaID = "https://schemas.antnest.dev/skill-registry/registry-api.ids-v2.schema.json"
	data, err := os.ReadFile("../../../../contracts/skill-registry/registry-api.ids-v2.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	common, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "common", "error.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	commonDoc, err := jsonschema.UnmarshalJSON(bytes.NewReader(common))
	if err != nil {
		t.Fatal(err)
	}
	if err := compiler.AddResource("https://schemas.antnest.dev/common/error.schema.json", commonDoc); err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{"pagination", "precondition", "ids"} {
		data, err := os.ReadFile("../../../../contracts/common/" + fragment + ".schema.json")
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if err := compiler.AddResource("https://schemas.antnest.dev/common/"+fragment+".schema.json", doc); err != nil {
			t.Fatal(err)
		}
	}
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
	handler := newTestHandler(t, NewService(&memoryStore{}))
	published := httptest.NewRecorder()
	handler.ServeHTTP(published, handler.Authenticate(publishRequest(t,
		map[string]any{"request_id": "schema-1", "organization_id": testOrg, "actor_id": testActor},
		skillZIP(t, "---\nname: code-review\ndescription: Helpful review\n---\n"))))
	if published.Code != http.StatusCreated {
		t.Fatalf("publish: %d %s", published.Code, published.Body.String())
	}
	assertSchema("version", published.Body.Bytes())
	var value Version
	if err := json.Unmarshal(published.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	listRequest := httptest.NewRequest(http.MethodGet, "/internal/skills?organization_id="+testOrg, nil)
	handler.Authenticate(listRequest)
	listRequest.Header.Set("Content-Type", "application/json")
	listed := httptest.NewRecorder()
	handler.ServeHTTP(listed, listRequest)
	if listed.Code != http.StatusOK {
		t.Fatalf("list: %d %s", listed.Code, listed.Body.String())
	}
	assertSchema("skill_page", listed.Body.Bytes())
	resolveBody, _ := json.Marshal(map[string]any{"organization_id": testOrg,
		"refs": []Reference{{SkillID: value.SkillID, Version: 1}}})
	resolveRequest := httptest.NewRequest(http.MethodPost, "/internal/skill-versions/resolve", bytes.NewReader(resolveBody))
	handler.Authenticate(resolveRequest)
	resolveRequest.Header.Set("Content-Type", "application/json")
	resolved := httptest.NewRecorder()
	handler.ServeHTTP(resolved, resolveRequest)
	if resolved.Code != http.StatusOK {
		t.Fatalf("resolve: %d %s", resolved.Code, resolved.Body.String())
	}
	assertSchema("resolve_response", resolved.Body.Bytes())
	errorResponse := httptest.NewRecorder()
	handler.ServeHTTP(errorResponse, httptest.NewRequest(http.MethodGet, "/internal/skills?organization_id="+testOrg, nil))
	assertSchema("error", errorResponse.Body.Bytes())
	shape, err := compiler.Compile(schemaID + "#/$defs/error")
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"missing top category":   func(v map[string]any) { delete(v, "category") },
		"missing nested request": func(v map[string]any) { delete(v["error"].(map[string]any), "request_id") },
		"unsafe top request_id":  func(v map[string]any) { v["request_id"] = "bad id with spaces" },
	} {
		var value map[string]any
		if err := json.Unmarshal(errorResponse.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		mutate(value)
		if err := shape.Validate(value); err == nil {
			t.Fatalf("mutated error body %q must violate the error schema", name)
		}
	}
}
