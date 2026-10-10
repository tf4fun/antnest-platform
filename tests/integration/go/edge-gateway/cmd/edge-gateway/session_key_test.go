package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRejectsInvalidCSRFKeyBeforeOpeningAnyService(t *testing.T) {
	directory := t.TempDir()
	short := filepath.Join(directory, "private-key-name")
	if err := os.WriteFile(short, []byte("do-not-log-key-material"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"", filepath.Join(directory, "missing"), directory, short} {
		values := map[string]string{
			"ANTNEST_EDGE_LISTEN":          "127.0.0.1:0",
			"ANTNEST_EDGE_CSRF_KEY_FILE":   path,
			"ANTNEST_IDENTITY_SERVICE_URL": "http://identity.internal",
			"ANTNEST_ADMIN_CONSOLE_URL":    "http://console.internal",
			"ANTNEST_AGENT_UI_URL":         "http://ui.internal",
			"ANTNEST_AGENT_CONTROLLER_URL": "http://controller.internal",
			"ANTNEST_AGENT_ACP_URL":        "http://acp.internal",
		}
		err := run(context.Background(), func(key string) (string, bool) { value, ok := values[key]; return value, ok })
		if err == nil || !strings.Contains(err.Error(), "CSRF") || strings.Contains(err.Error(), directory) || strings.Contains(err.Error(), "do-not-log-key-material") {
			t.Fatalf("key startup rejection=%v", err)
		}
	}
}
