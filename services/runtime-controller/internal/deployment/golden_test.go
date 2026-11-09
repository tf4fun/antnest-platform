package deployment

import (
	"bytes"
	"encoding/json"
	"flag"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

var updateGolden = flag.Bool("update", false, "rewrite captured golden contract documents")

func writeGoldenDocument(t *testing.T, path string, body []byte) {
	t.Helper()
	var document any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("golden candidate is not JSON: %v", err)
	}
	indented, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(indented, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertJSONEqual(t *testing.T, expected, actual []byte) {
	t.Helper()
	var expectedDocument, actualDocument any
	if err := json.Unmarshal(expected, &expectedDocument); err != nil {
		t.Fatalf("golden document is not JSON: %v", err)
	}
	if err := json.Unmarshal(actual, &actualDocument); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if !reflect.DeepEqual(expectedDocument, actualDocument) {
		t.Fatalf("document differs\nexpected: %s\nactual:   %s", expected, actual)
	}
}

func contractCompiler(t *testing.T) *jsonschema.Compiler {
	t.Helper()
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	for _, dir := range []string{"../../../../contracts"} {
		if err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".schema.json") {
				return err
			}
			payload, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			var meta struct {
				ID string `json:"$id"`
			}
			if err := json.Unmarshal(payload, &meta); err != nil || meta.ID == "" {
				return err
			}
			document, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
			if err != nil {
				return err
			}
			return compiler.AddResource(meta.ID, document)
		}); err != nil {
			t.Fatal(err)
		}
	}
	return compiler
}

func TestRuntimeSpecGolden(t *testing.T) {
	t.Parallel()

	spec, err := testConfiguration().Resolve("agent-1", 7)
	if err != nil {
		t.Fatalf("resolve deployment: %v", err)
	}
	spec.RuntimeSpec.Authentication = &RuntimeAuthentication{
		ConnectionID:   "rci_22222222222222222222222222222222",
		CallersFile:    instanceauth.CallersFile,
		ReceiverDigest: "sha256:" + strings.Repeat("a", 64),
		Tunnel: instanceauth.TunnelDescriptor{
			KeyID:      "rtk_0123456789abcdef0123456789abcdef",
			KeysFile:   instanceauth.TunnelFile,
			KeysDigest: "sha256:" + strings.Repeat("b", 64),
		},
	}
	if err := spec.ValidateFor(Key{AgentID: "agent-1", Generation: 7}); err != nil {
		t.Fatalf("deployment is invalid: %v", err)
	}
	body, err := json.Marshal(spec.RuntimeSpec)
	if err != nil {
		t.Fatal(err)
	}
	golden := "../../../../contracts/runtime/examples/runtime-spec.current.json"
	if *updateGolden {
		writeGoldenDocument(t, golden, body)
	}
	definition, err := contractCompiler(t).Compile("https://schemas.antnest.dev/runtime/runtime-spec.ids-v2.schema.json")
	if err != nil {
		t.Fatalf("compile runtime spec schema: %v", err)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if err := definition.Validate(instance); err != nil {
		t.Fatalf("runtime spec violates schema: %v", err)
	}
	expected, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden %s: %v (run with -update)", golden, err)
	}
	assertJSONEqual(t, expected, body)
	var wire map[string]any
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["schema_version"] != float64(1) {
		t.Fatalf("runtime_spec schema_version = %v, want 1", wire["schema_version"])
	}
}

func TestRuntimeSpecRejectsUnsupportedVersion(t *testing.T) {
	t.Parallel()

	body, err := json.Marshal(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	var legacy Deployment
	if err := json.Unmarshal(body, &legacy); err != nil {
		t.Fatal(err)
	}
	if err := legacy.ValidateFor(Key{AgentID: "agent-1", Generation: 7}); err != nil {
		t.Fatalf("deployment without schema_version must stay valid: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatal(err)
	}
	spec, _ := document["runtime_spec"].(map[string]any)
	spec["schema_version"] = float64(9)
	injected, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	var future Deployment
	if err := json.Unmarshal(injected, &future); err != nil {
		t.Fatal(err)
	}
	if err := future.ValidateFor(Key{AgentID: "agent-1", Generation: 7}); err == nil {
		t.Fatal("runtime_spec schema_version 9 must be rejected")
	}
}
