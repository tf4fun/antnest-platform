package server

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type resourceIDVectors struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func readResourceIDVectors(t *testing.T) map[string]resourceIDVectors {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/common/id-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors map[string]resourceIDVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func principalDocument(t *testing.T) map[string]any {
	t.Helper()
	data, err := json.Marshal(displayPrincipal(t, "Engineering", false))
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestResourceIDSessionSchemaVectors(t *testing.T) {
	vectors := readResourceIDVectors(t)
	schema := compileOrganizationSchema(t, "edge-gateway/session-response.ids-v2.schema.json", "principal")
	for _, field := range []struct {
		name string
		kind string
	}{
		{"organization_id", "organizationId"},
		{"user_id", "userId"},
	} {
		for _, value := range vectors[field.kind].Accept {
			document := principalDocument(t)
			document[field.name] = value
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(mustJSON(t, document)))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(instance); err != nil {
				t.Errorf("%s must accept %q: %v", field.name, value, err)
			}
			if document[field.name] != value {
				t.Errorf("%s was normalized from %q", field.name, value)
			}
		}
		for _, value := range vectors[field.kind].Reject {
			document := principalDocument(t)
			document[field.name] = value
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(mustJSON(t, document)))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(instance); err == nil {
				t.Errorf("%s must reject %q", field.name, value)
			}
		}
		for _, value := range []any{42, true, nil, []string{"user-1"}, map[string]string{"id": "user-1"}} {
			document := principalDocument(t)
			document[field.name] = value
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(mustJSON(t, document)))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(instance); err == nil {
				t.Errorf("%s must reject non-string %v", field.name, value)
			}
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestResourceIDSharedPatternEngine(t *testing.T) {
	for _, pattern := range []string{`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`, `[^A-Za-z0-9_.-]`} {
		engine, err := gatewayContractPattern(pattern)
		if err != nil {
			t.Fatalf("gatewayContractPattern(%q): %v", pattern, err)
		}
		if _, ok := engine.(*regexp.Regexp); !ok {
			t.Fatalf("pattern %q must use the Go regexp engine, got %T", pattern, engine)
		}
		for _, pattern := range []string{`^\S{1,200}$`, `^[\\p{L}\\p{N}]+$`, `^(?=x)y$`} {
			engine, err := gatewayContractPattern(pattern)
			if err != nil {
				t.Fatalf("gatewayContractPattern(%q): %v", pattern, err)
			}
			if _, ok := engine.(*regexp.Regexp); ok {
				t.Fatalf("pattern %q must keep the ECMAScript engine, got %T", pattern, engine)
			}
		}
	}
	matcher, err := gatewayContractPattern(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)
	if err != nil {
		t.Fatal(err)
	}
	vectors := readResourceIDVectors(t)
	if !matcher.MatchString("user-1") {
		t.Fatal("shared pattern must accept user-1")
	}
	for _, kind := range []string{"organizationId", "userId"} {
		for _, value := range vectors[kind].Accept {
			if !matcher.MatchString(value) {
				t.Errorf("%s must accept %q", kind, value)
			}
		}
		for _, value := range vectors[kind].Reject {
			if matcher.MatchString(value) {
				t.Errorf("%s must reject %q", kind, value)
			}
		}
	}
}
