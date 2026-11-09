package server

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
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
