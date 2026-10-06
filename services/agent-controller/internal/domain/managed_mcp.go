package domain

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

// MCPServer describes a Runtime-owned process, not an ACP client connection.
type MCPServer struct {
	ID        string               `json:"id"`
	Command   string               `json:"command"`
	Args      []string             `json:"args"`
	Env       map[string]string    `json:"env"`
	SecretEnv map[string]MCPSecret `json:"secret_env,omitempty"`
}

// Value and Keep are accepted only at the catalog write boundary. Persisted
// Runtime input contains Set/Fingerprint only; secret ciphertext lives separately.
type MCPSecret struct {
	Value       *string `json:"value,omitempty"`
	Keep        bool    `json:"keep,omitempty"`
	Set         bool    `json:"set,omitempty"`
	Fingerprint string  `json:"fingerprint,omitempty"`
}

func (secret MCPSecret) String() string   { return "MCPSecret(redacted)" }
func (secret MCPSecret) GoString() string { return secret.String() }

func ValidateMCPServers(servers []MCPServer) error { return validateMCPServers(servers) }

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
		result[index].SecretEnv = make(map[string]MCPSecret, len(server.SecretEnv))
		for key, value := range server.SecretEnv {
			if value.Value != nil {
				copyValue := *value.Value
				value.Value = &copyValue
			}
			result[index].SecretEnv[key] = value
		}
	}
	return result
}

func cloneRuntime(runtime RuntimeSpecInput) RuntimeSpecInput {
	runtime.MCPServers = CloneMCPServers(runtime.MCPServers)
	return runtime
}

func validateMCPServers(servers []MCPServer) error {
	if len(servers) > 8 {
		return errors.New("mcp_servers exceeds eight servers")
	}
	seen := make(map[string]bool, len(servers))
	for _, server := range servers {
		if !managedIDPattern.MatchString(server.ID) || seen[server.ID] {
			return errors.New("invalid or duplicate MCP server ID")
		}
		seen[server.ID] = true
		if err := server.validate(); err != nil {
			return err
		}
	}
	encoded, err := json.Marshal(CloneMCPServers(servers))
	if err != nil || len(encoded) > 64*1024 {
		return errors.New("encoded MCP configuration exceeds 64 KiB")
	}
	return nil
}

func (server MCPServer) validate() error {
	if strings.TrimSpace(server.Command) == "" || !boundedMCPText(server.Command, 4096) || len(server.Args) > 64 {
		return errors.New("invalid MCP command or arguments")
	}
	size := len(server.Command)
	for _, argument := range server.Args {
		if !boundedMCPText(argument, 8192) {
			return errors.New("invalid MCP argument")
		}
		size += len(argument)
	}
	if len(server.Env)+len(server.SecretEnv) > 64 {
		return errors.New("too many MCP environment variables")
	}
	for key, value := range server.Env {
		if !managedEnvPattern.MatchString(key) || reservedMCPEnvironment(key) || !boundedMCPText(value, 8192) {
			return errors.New("invalid or reserved MCP environment variable")
		}
		size += len(key) + len(value)
	}
	for key, value := range server.SecretEnv {
		_, overlap := server.Env[key]
		if overlap || !managedEnvPattern.MatchString(key) || reservedMCPEnvironment(key) || value.Value != nil || value.Keep || !value.Set || !managedFingerprintPattern.MatchString(value.Fingerprint) {
			return errors.New("invalid managed MCP secret descriptor")
		}
		size += len(key)
	}
	if size > 32*1024 {
		return errors.New("MCP server configuration exceeds 32 KiB")
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
