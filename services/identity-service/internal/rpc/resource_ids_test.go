package rpc

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
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

func TestResourceIDSharedVectors(t *testing.T) {
	vectors := readResourceIDVectors(t)
	for _, kind := range []string{"organizationId", "userId", "agentId"} {
		for _, value := range vectors[kind].Accept {
			if !domain.ValidID(value) {
				t.Errorf("%s must accept %q", kind, value)
			}
		}
		for _, value := range vectors[kind].Reject {
			if domain.ValidID(value) {
				t.Errorf("%s must reject %q", kind, value)
			}
		}
	}
}

func TestResourceIDDirectorySchemaVectors(t *testing.T) {
	vectors := readResourceIDVectors(t)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	for _, path := range []string{
		"../../../../contracts/common/ids.schema.json",
		"../../../../contracts/identity/directory.ids-v2.schema.json",
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var meta struct {
			ID string `json:"$id"`
		}
		if err := json.Unmarshal(raw, &meta); err != nil {
			t.Fatal(err)
		}
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := compiler.AddResource(meta.ID, document); err != nil {
			t.Fatal(err)
		}
	}
	const directory = "https://schemas.antnest.dev/identity/directory.ids-v2.schema.json"
	cases := []struct {
		kind      string
		reference string
	}{
		{"organizationId", directory + "#/$defs/membership/properties/organization_id"},
		{"userId", directory + "#/$defs/membership/properties/user_id"},
		{"userId", directory + "#/$defs/user/properties/id"},
	}
	for _, check := range cases {
		definition, err := compiler.Compile(check.reference)
		if err != nil {
			t.Fatalf("compile %s: %v", check.reference, err)
		}
		for _, value := range vectors[check.kind].Accept {
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
			if err != nil {
				t.Fatal(err)
			}
			if err := definition.Validate(instance); err != nil {
				t.Errorf("%s %s must accept %q: %v", check.kind, check.reference, value, err)
			}
		}
		for _, value := range vectors[check.kind].Reject {
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
			if err != nil {
				t.Fatal(err)
			}
			if err := definition.Validate(instance); err == nil {
				t.Errorf("%s %s must reject %q", check.kind, check.reference, value)
			}
		}
	}
}

func TestResourceIDGeneratorPreserved(t *testing.T) {
	typed := regexp.MustCompile(`^(org|user)_[0-9a-f]{32}$`)
	for _, kind := range []string{"org", "user"} {
		produced, err := identityid.New(kind)
		if err != nil {
			t.Fatal(err)
		}
		if !typed.MatchString(produced) {
			t.Fatalf("identityid.New(%q) changed format: %q", kind, produced)
		}
		if !domain.ValidID(produced) {
			t.Fatalf("identityid.New(%q) not a shared opaque ID: %q", kind, produced)
		}
	}
}
