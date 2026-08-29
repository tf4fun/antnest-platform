package runtimeconn

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type connectFixtureDocument struct {
	RuntimeConnectResults []struct {
		Name  string          `json:"name"`
		Valid bool            `json:"valid"`
		Value json.RawMessage `json:"value"`
	} `json:"runtime_connect_results"`
}

func TestSharedRuntimeConnectResultFixtures(t *testing.T) {
	t.Parallel()

	fixtures := loadConnectFixtureDocument(t)
	if len(fixtures.RuntimeConnectResults) == 0 {
		t.Fatal("Runtime connect result fixtures are missing")
	}
	for _, fixture := range fixtures.RuntimeConnectResults {
		t.Run(fixture.Name, func(t *testing.T) {
			t.Parallel()
			var result ConnectResult
			err := decodeJSONStrict(fixture.Value, &result)
			if err == nil {
				err = validateConnectResultFixture(result)
			}
			if (err == nil) != fixture.Valid {
				t.Fatalf("decode error = %v, valid = %t", err, fixture.Valid)
			}
		})
	}
}

func validateConnectResultFixture(result ConnectResult) error {
	if result.ProtocolVersion != ProtocolVersion || strings.TrimSpace(result.RuntimeInstanceID) == "" ||
		result.Generation == 0 || strings.TrimSpace(result.AgentID) == "" || result.ConnectionEpoch == 0 ||
		result.WorkEpochFloor == 0 || result.PolicyRevision == 0 || result.PolicyEpoch == 0 ||
		result.LeaseExpiresUnixMS <= 0 {
		return fmt.Errorf("Runtime connect identity and lease fields are required")
	}
	switch result.NetworkMode {
	case "restricted":
		if result.EgressEndpoint != "" || result.EgressToken != "" || result.EgressTokenExpires != 0 {
			return fmt.Errorf("restricted admission cannot issue an egress token")
		}
	case "unrestricted":
		if strings.TrimSpace(result.EgressEndpoint) == "" || strings.TrimSpace(result.EgressToken) == "" ||
			result.EgressTokenExpires <= 0 {
			return fmt.Errorf("unrestricted admission requires an egress endpoint and token")
		}
	default:
		return fmt.Errorf("Runtime connect network mode is invalid")
	}
	return nil
}

func loadConnectFixtureDocument(t *testing.T) connectFixtureDocument {
	t.Helper()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve Runtime connect fixture caller")
	}
	path := filepath.Join(
		filepath.Dir(currentFile), "..", "..", "..", "..",
		"contracts", "runtime", "v1", "contracts-v1.json",
	)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Runtime connect fixtures: %v", err)
	}
	var fixtures connectFixtureDocument
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("decode Runtime connect fixtures: %v", err)
	}
	return fixtures
}
