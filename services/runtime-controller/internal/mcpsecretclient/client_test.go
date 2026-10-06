package mcpsecretclient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestResolverPinsLocationAndRejectsWrongOrUnboundedValues(t *testing.T) {
	secret := "synthetic-private-resolver-canary"
	digest := sha256.Sum256([]byte(secret))
	servers := []deployment.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]deployment.MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "sha256:" + hex.EncodeToString(digest[:4])}}}}
	source := &deployment.MCPTemplateSource{OrganizationID: "org", TemplateID: "template", Revision: 7}
	for _, body := range []string{`{"docs":{"API_KEY":"` + secret + `"}}`, `{"docs":{"API_KEY":"wrong"}}`, `{"docs":{"OTHER":"` + secret + `"}}`, `{"docs":{"API_KEY":"` + secret + `"},"other":{}}`, `{"docs":{"API_KEY":"` + secret + `","API_KEY":"` + secret + `"}}`, strings.Repeat(" ", 65537)} {
		t.Run(body[:min(20, len(body))], func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/internal/managed-mcp-secrets/resolve" {
					t.Error("wrong bootstrap route")
				}
				var requested deployment.MCPTemplateSource
				if json.NewDecoder(r.Body).Decode(&requested) != nil || requested != *source {
					t.Error("request did not pin exact source")
				}
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			client, err := New(server.URL, server.Client(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			values, err := client.Resolve(context.Background(), source, servers)
			if body == `{"docs":{"API_KEY":"`+secret+`"}}` {
				if err != nil || values["docs"]["API_KEY"] != secret {
					t.Fatal("bootstrap failed", err)
				}
			} else {
				if err == nil {
					t.Fatal("invalid bootstrap accepted")
				}
				if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "wrong") {
					t.Fatal("error leaked response")
				}
			}
		})
	}
}
