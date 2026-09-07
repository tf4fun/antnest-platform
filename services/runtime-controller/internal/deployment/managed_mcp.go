package deployment

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

// MCPServer is startup input, never public inspection or telemetry data.
type MCPServer struct {
	ID      string            `json:"id"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

func (server MCPServer) String() string   { return "MCPServer(" + server.ID + ")" }
func (server MCPServer) GoString() string { return server.String() }

var managedIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,15}$`)
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
	if len(server.Env) > 64 {
		return invalid("too many MCP environment variables")
	}
	for key, value := range server.Env {
		if !managedEnvPattern.MatchString(key) || key == "HOME" || key == "PATH" || strings.HasPrefix(key, "ANTNEST_") || !boundedMCPText(value, 8192) {
			return invalid("invalid or reserved MCP environment variable")
		}
		size += len(key) + len(value)
	}
	if size > 32*1024 {
		return invalid("MCP server configuration exceeds 32 KiB")
	}
	return nil
}

func boundedMCPText(value string, limit int) bool {
	return len(value) <= limit && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}
