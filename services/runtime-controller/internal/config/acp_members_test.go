package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const acpMemberFileVariable = "ANTNEST_RUNTIME_ACP_MEMBERS_FILE"
const validAcpMember = `{"member_id":"acp-a","container_selector":"antnest-acp-a","network":"antnest-owner","probe_origin":"http://acp-a:8085"}`

func TestLoadAcpMembersUsesOnlyTheConfiguredCatalog(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "runtime-management",
	}
	configuration, err := Load(testEnvironment(t, values))
	if err != nil || len(configuration.ACPMembers) != 0 {
		t.Fatal("absent catalog did not preserve an empty optional membership")
	}
	configuration.Authentication.CloseIdleConnections()
	path := acpCatalogFile(t, `{"version":1,"members":[`+validAcpMember+`]}`)
	values[acpMemberFileVariable] = path
	configuration, err = Load(testEnvironment(t, values))
	if err != nil {
		t.Fatal(err)
	}
	defer configuration.Authentication.CloseIdleConnections()
	if len(configuration.ACPMembers) != 1 {
		t.Fatal("configured member was not loaded")
	}
	member := configuration.ACPMembers[0]
	if member.ID != "acp-a" || member.Selector != "antnest-acp-a" || member.Network != "antnest-owner" || member.Origin != "http://acp-a:8085" {
		t.Fatal("configured member facts were changed or derived from the Runtime network")
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"members":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if len(configuration.ACPMembers) != 1 || configuration.ACPMembers[0] != member {
		t.Fatal("loaded catalog did not remain an independent startup snapshot")
	}
}

func TestLoadAcpMembersRejectsAmbiguousAndInvalidCatalogs(t *testing.T) {
	valid := `{"version":1,"members":[` + validAcpMember + `]}`
	cases := map[string]string{
		"missing version":         `{"members":[]}`,
		"wrong version":           `{"version":2,"members":[]}`,
		"missing members":         `{"version":1}`,
		"null members":            `{"version":1,"members":null}`,
		"array root":              `[]`,
		"multiple documents":      valid + ` {}`,
		"duplicate version":       strings.Replace(valid, `"version":1`, `"version":1,"version":1`, 1),
		"case alias":              strings.Replace(valid, `"members"`, `"Members"`, 1),
		"unknown root":            strings.Replace(valid, `"version":1`, `"version":1,"unsafe":true`, 1),
		"duplicate member field":  strings.Replace(valid, `"member_id":"acp-a"`, `"member_id":"acp-a","\u006dember_id":"acp-b"`, 1),
		"unknown member field":    strings.Replace(valid, `"member_id":"acp-a"`, `"member_id":"acp-a","address":"127.0.0.1"`, 1),
		"duplicate member ID":     `{"version":1,"members":[` + validAcpMember + `,` + validAcpMember + `]}`,
		"uppercase ID":            strings.Replace(valid, `"acp-a"`, `"ACP-a"`, 1),
		"empty selector":          strings.Replace(valid, `"antnest-acp-a"`, `""`, 1),
		"empty network":           strings.Replace(valid, `"antnest-owner"`, `""`, 1),
		"bad origin scheme":       strings.Replace(valid, `http://acp-a:8085`, `file:///etc/passwd`, 1),
		"origin credentials":      strings.Replace(valid, `http://acp-a:8085`, `http://private-value@acp-a:8085`, 1),
		"origin missing hostname": strings.Replace(valid, `http://acp-a:8085`, `http://:8085`, 1),
		"origin oversized port":   strings.Replace(valid, `http://acp-a:8085`, `http://acp-a:65536`, 1),
		"origin zero port":        strings.Replace(valid, `http://acp-a:8085`, `http://acp-a:0`, 1),
		"origin path":             strings.Replace(valid, `http://acp-a:8085`, `http://acp-a:8085/elsewhere`, 1),
		"origin query":            strings.Replace(valid, `http://acp-a:8085`, `http://acp-a:8085?selector=private-value`, 1),
		"oversized file":          valid + strings.Repeat(" ", 64<<10),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
				"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "runtime-management",
				acpMemberFileVariable:                     acpCatalogFile(t, raw),
			}
			configuration, err := Load(testEnvironment(t, values))
			if configuration.Authentication != nil {
				configuration.Authentication.CloseIdleConnections()
			}
			if err == nil || !strings.Contains(err.Error(), acpMemberFileVariable) || strings.Contains(err.Error(), "private-value") {
				t.Fatal("invalid catalog was accepted or disclosed private configuration")
			}
		})
	}
}

func TestLoadAcpMembersBoundsCountAndRejectsUnavailableFiles(t *testing.T) {
	for _, count := range []int{0, 128, 129} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			members := make([]map[string]string, 0, count)
			for i := 0; i < count; i++ {
				members = append(members, map[string]string{"member_id": fmt.Sprintf("acp-%d", i), "container_selector": fmt.Sprintf("container-%d", i), "network": "owner-private", "probe_origin": "http://acp-owner:8085"})
			}
			raw, err := json.Marshal(map[string]any{"version": 1, "members": members})
			if err != nil {
				t.Fatal(err)
			}
			values := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "runtime-management", acpMemberFileVariable: acpCatalogFile(t, string(raw))}
			configuration, err := Load(testEnvironment(t, values))
			if configuration.Authentication != nil {
				configuration.Authentication.CloseIdleConnections()
			}
			if (err == nil) != (count <= 128) {
				t.Fatal("catalog count limit was not enforced")
			}
			if err == nil && len(configuration.ACPMembers) != count {
				t.Fatal("catalog members were silently truncated")
			}
		})
	}
	for _, path := range []string{filepath.Join(t.TempDir(), "missing.json"), t.TempDir()} {
		values := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "runtime-management", acpMemberFileVariable: path}
		configuration, err := Load(testEnvironment(t, values))
		if configuration.Authentication != nil {
			configuration.Authentication.CloseIdleConnections()
		}
		if err == nil || !strings.Contains(err.Error(), acpMemberFileVariable) {
			t.Fatal("unavailable catalog was ignored")
		}
	}
}

func acpCatalogFile(t *testing.T, raw string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "acp-members.json")
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
