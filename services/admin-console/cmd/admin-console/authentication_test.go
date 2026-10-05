package main

import (
	"context"
	"strings"
	"testing"
)

func TestStartupRejectsMissingAuthenticationBeforeListener(t *testing.T) {
	values := map[string]string{"ANTNEST_ADMIN_CONSOLE_LISTEN": ":not-a-port", "ANTNEST_IDENTITY_SERVICE_URL": "http://identity.internal", "ANTNEST_AGENT_CONTROLLER_URL": "http://controller.internal", "ANTNEST_AGENT_ACP_SERVICE_URL": "http://acp.internal"}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err := run(ctx, func(key string) (string, bool) { value, present := values[key]; return value, present })
	if err == nil || !strings.Contains(err.Error(), "ANTNEST_SERVICE_AUTH_MODE") {
		t.Fatalf("missing mode reached later startup phase: %v", err)
	}
}
