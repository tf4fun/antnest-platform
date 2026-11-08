package rpc

import (
	"bytes"
	"encoding/json"
	"flag"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
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

func TestRuntimeControllerGolden(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	service := &fakeService{
		inspection: deployment.Environment{
			TunnelKeyID:        "rtk_0123456789abcdef0123456789abcdef",
			Phase:              deployment.PhaseRunning,
			AgentID:            "agent-1",
			RuntimeRevision:    testRuntimeRevision,
			LifecycleState:     deployment.LifecycleProvisioned,
			Health:             deployment.HealthHealthy,
			MCPEndpoint:        "http://antnest-runtime-agent-1:8093/mcp",
			RuntimeEndpoint:    "10.243.1.20",
			RuntimeExecutionID: "boot-1",
			ObservedAt:         now,
		},
		observations: []deployment.Observation{
			{Sequence: 1, Kind: deployment.ObservationReconciled, ObservedAt: now},
			{Sequence: 2, Kind: deployment.ObservationUpdated, AgentID: "agent-1",
				RuntimeRevision: testRuntimeRevision, ObservedAt: now},
			{Sequence: 3, Kind: deployment.ObservationHealthy, AgentID: "agent-1",
				RuntimeRevision: testRuntimeRevision, RuntimeExecutionID: "boot-1", ObservedAt: now},
		},
	}
	boundary := newTestHandler(t, service)
	compiler := contractCompiler(t)
	const identifier = "https://schemas.antnest.dev/runtime-controller/control-api.ids-v2.schema.json"
	for _, golden := range []struct {
		name string
		path string
		def  string
	}{
		{name: "rc-inspection.healthy", path: "/internal/runtimes/agent-1", def: "runtime_inspection"},
		{name: "rc-observations.current", path: "/internal/runtime-observations?after_sequence=0&limit=20", def: "observation_list"},
	} {
		t.Run(golden.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, golden.path, nil))
			if response.Code != http.StatusOK {
				t.Fatalf("%s status = %d: %s", golden.name, response.Code, response.Body.String())
			}
			body := response.Body.Bytes()
			definition, err := compiler.Compile(identifier + "#/$defs/" + golden.def)
			if err != nil {
				t.Fatalf("compile %s: %v", golden.def, err)
			}
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if err := definition.Validate(instance); err != nil {
				t.Fatalf("%s violates schema: %v", golden.name, err)
			}
			file := "../../../../contracts/runtime/examples/" + golden.name + ".json"
			if *updateGolden {
				writeGoldenDocument(t, file, body)
			}
			expected, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read golden %s: %v (run with -update)", file, err)
			}
			assertJSONEqual(t, expected, body)
			if golden.def == "observation_list" {
				var wire struct {
					Observations []map[string]any `json:"observations"`
				}
				if err := json.Unmarshal(body, &wire); err != nil {
					t.Fatal(err)
				}
				if len(wire.Observations) == 0 {
					t.Fatal("observation_list response carries no observations")
				}
				for index, observation := range wire.Observations {
					if observation["schema_version"] != float64(1) {
						t.Fatalf("observation[%d] schema_version = %v, want 1", index, observation["schema_version"])
					}
				}
			}
		})
	}
}
