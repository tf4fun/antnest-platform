package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
)

func TestStartupLogsEffectiveProcessPrivileges(t *testing.T) {
	for _, capabilities := range []string{"0000000000000000", "0000000000001001"} {
		var output bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&output, nil))
		err := logStartupPrivileges(logger, 65532, 1000, "linux", func(path string) ([]byte, error) {
			if path != "/proc/self/status" {
				t.Fatalf("unexpected process status path %q", path)
			}
			return []byte("Name:\truntime-controller\nCapEff:\t" + capabilities + "\n"), nil
		})
		if err != nil {
			t.Fatal(err)
		}
		var record map[string]any
		if err := json.Unmarshal(output.Bytes(), &record); err != nil {
			t.Fatalf("missing process privilege log: %v", err)
		}
		if record["uid"] != float64(65532) || record["gid"] != float64(1000) || record["effective_capabilities"] != capabilities {
			t.Fatalf("incorrect process privileges: %s", output.String())
		}
	}
}

func TestStartupCannotHideUnreadableLinuxCapabilities(t *testing.T) {
	readFailure := errors.New("process status unavailable")
	for _, test := range []struct {
		name   string
		status string
		err    error
	}{
		{"read failure", "", readFailure},
		{"missing CapEff", "Name:\truntime-controller\n", nil},
		{"invalid CapEff", "CapEff:\tnot-hex\n", nil},
		{"overflow CapEff", "CapEff:\t10000000000000000\n", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, nil))
			err := logStartupPrivileges(logger, 65532, 65532, "linux", func(string) ([]byte, error) {
				return []byte(test.status), test.err
			})
			if err == nil || (test.err != nil && !errors.Is(err, test.err)) {
				t.Fatalf("unreadable privileges were hidden: %v", err)
			}
		})
	}
}

func TestNativeDevelopmentLogsCapabilitiesAsUnsupported(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	if err := logStartupPrivileges(logger, 501, 20, "darwin", func(string) ([]byte, error) {
		t.Fatal("non-Linux development tried to read procfs")
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record["uid"] != float64(501) || record["gid"] != float64(20) || record["effective_capabilities"] != "unsupported" {
		t.Fatalf("incorrect native privileges: %s", output.String())
	}
}
