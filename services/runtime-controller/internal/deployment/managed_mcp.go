package deployment

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

// MCPServer is startup input, never public inspection or telemetry data.
type MCPServer struct {
	ID        string                         `json:"id"`
	Command   string                         `json:"command"`
	Args      []string                       `json:"args"`
	Env       map[string]string              `json:"env"`
	SecretEnv map[string]MCPSecretDescriptor `json:"secret_env,omitempty"`
}

type MCPSecretDescriptor struct {
	Set         bool   `json:"set"`
	Fingerprint string `json:"fingerprint"`
}

type MCPTemplateSource struct {
	OrganizationID string `json:"organization_id"`
	TemplateID     string `json:"template_id"`
	Revision       int64  `json:"revision"`
}

func (source *MCPTemplateSource) Validate() error {
	if source == nil || validateIdentifier("organization_id", source.OrganizationID) != nil || validateIdentifier("template_id", source.TemplateID) != nil || source.Revision < 1 {
		return invalid("managed MCP Template source is invalid")
	}
	return nil
}

func HasMCPSecrets(servers []MCPServer) bool {
	for _, server := range servers {
		if len(server.SecretEnv) > 0 {
			return true
		}
	}
	return false
}

func ValidateMCPSecretValues(servers []MCPServer, values map[string]map[string]string) error {
	if err := validateMCPServers(servers); err != nil {
		return err
	}
	resolved := CloneMCPServers(servers)
	expectedServers := 0
	for index, server := range servers {
		resolved[index].SecretEnv = nil
		if len(server.SecretEnv) == 0 {
			continue
		}
		expectedServers++
		if len(values[server.ID]) != len(server.SecretEnv) {
			return invalid("managed MCP secret names differ")
		}
		for name := range server.SecretEnv {
			value, ok := values[server.ID][name]
			if !ok || !boundedMCPText(value, 8192) {
				return invalid("managed MCP secret verification failed")
			}
			resolved[index].Env[name] = value
		}
	}
	if len(values) != expectedServers {
		return invalid("managed MCP secret servers differ")
	}
	return validateMCPServers(resolved)
}

func (server MCPServer) String() string   { return "MCPServer(" + server.ID + ")" }
func (server MCPServer) GoString() string { return server.String() }

var managedIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,15}$`)
var managedFingerprintPattern = regexp.MustCompile(`^hmac-sha256:[0-9a-f]{32}$`)
var managedEnvPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

func CloneMCPServers(servers []MCPServer) []MCPServer {
	if len(servers) == 0 {
		return nil
	}
	result := make([]MCPServer, len(servers))
	for index, server := range servers {
		result[index] = server
		result[index].Args = append(make([]string, 0, len(server.Args)), server.Args...)
		result[index].Env = make(map[string]string, len(server.Env))
		for key, value := range server.Env {
			result[index].Env[key] = value
		}
		result[index].SecretEnv = make(map[string]MCPSecretDescriptor, len(server.SecretEnv))
		for key, value := range server.SecretEnv {
			result[index].SecretEnv[key] = value
		}
	}
	return result
}

func validateMCPServers(servers []MCPServer) error {
	if len(servers) > 8 {
		return invalid("mcp_servers exceeds eight servers")
	}
	seen := make(map[string]bool, len(servers))
	for _, server := range servers {
		if !managedIDPattern.MatchString(server.ID) || seen[server.ID] {
			return invalid("invalid or duplicate MCP server ID")
		}
		seen[server.ID] = true
		if err := server.validate(); err != nil {
			return err
		}
	}
	encoded, err := json.Marshal(CloneMCPServers(servers))
	if err != nil || len(encoded) > 64*1024 {
		return invalid("encoded MCP configuration exceeds 64 KiB")
	}
	return nil
}

func (server MCPServer) validate() error {
	if strings.TrimSpace(server.Command) == "" || !boundedMCPText(server.Command, 4096) || len(server.Args) > 64 {
		return invalid("invalid MCP command or arguments")
	}
	size := len(server.Command)
	for _, argument := range server.Args {
		if !boundedMCPText(argument, 8192) {
			return invalid("invalid MCP argument")
		}
		size += len(argument)
	}
	if len(server.Env)+len(server.SecretEnv) > 64 {
		return invalid("too many MCP environment variables")
	}
	for key, value := range server.Env {
		if !managedEnvPattern.MatchString(key) || reservedMCPEnvironment(key) || !boundedMCPText(value, 8192) {
			return invalid("invalid or reserved MCP environment variable")
		}
		size += len(key) + len(value)
	}
	for key, value := range server.SecretEnv {
		_, overlap := server.Env[key]
		if overlap || !managedEnvPattern.MatchString(key) || reservedMCPEnvironment(key) || !value.Set || !managedFingerprintPattern.MatchString(value.Fingerprint) {
			return invalid("invalid managed MCP secret descriptor")
		}
		size += len(key)
	}
	if size > 32*1024 {
		return invalid("MCP server configuration exceeds 32 KiB")
	}
	return nil
}

func boundedMCPText(value string, limit int) bool {
	return len(value) <= limit && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

func reservedMCPEnvironment(name string) bool {
	switch name {
	case "HOME", "PATH", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR":
		return true
	}
	return strings.HasPrefix(name, "ANTNEST_")
}
