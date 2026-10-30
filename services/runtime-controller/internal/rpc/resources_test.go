package rpc

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeResources(t *testing.T, body string) (resourceLimitsDTO, error) {
	t.Helper()
	var value resourceLimitsDTO
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&value)
	return value, err
}

func TestResourceLimitsRejectsExplicitNullAtTheHTTPBoundary(t *testing.T) {
	for _, field := range []string{"cpu_millis", "workspace_bytes"} {
		body := `{"memory_bytes":1,"pids_limit":16,"tmpfs_bytes":2,"` + field + `":null}`
		if _, err := decodeResources(t, body); err == nil {
			t.Fatalf("explicit null %s must be rejected", field)
		}
	}
}

func TestResourceLimitsPreserveOmissionVersusExplicitZero(t *testing.T) {
	omitted, err := decodeResources(t, `{"memory_bytes":1,"pids_limit":16,"tmpfs_bytes":2}`)
	if err != nil {
		t.Fatal(err)
	}
	if omitted.CPUMillis != nil || omitted.WorkspaceBytes != nil {
		t.Fatal("omission must stay nil for defaults")
	}
	zero, err := decodeResources(t, `{"memory_bytes":1,"pids_limit":16,"tmpfs_bytes":2,"cpu_millis":0}`)
	if err != nil {
		t.Fatal(err)
	}
	if zero.CPUMillis == nil || *zero.CPUMillis != 0 {
		t.Fatal("explicit zero must decode as a pointer, not omission")
	}
	if _, err := decodeResources(t, `{"memory_bytes":1,"pids_limit":16,"tmpfs_bytes":2,"unknown_limit":3}`); err == nil {
		t.Fatal("unknown resource fields must still be rejected")
	}
}
