package server

import (
	"bytes"
	"net/http/httptest"
	"testing"
)

func TestTemplateMCPDecodingRejectsSilentUnicodeReplacement(t *testing.T) {
	t.Parallel()
	for _, command := range [][]byte{[]byte(`"\ud800"`), []byte(`"\udc00"`), {'"', 255, '"'}} {
		for _, target := range []any{&createTemplateRequest{}, &reviseTemplateRequest{}} {
			payload := append([]byte(`{"runtime":{"mcp_servers":[{"id":"documents","command":`), command...)
			payload = append(payload, []byte(`}]}}`)...)
			response := httptest.NewRecorder()
			if decodeJSON(response, httptest.NewRequest("POST", "/", bytes.NewReader(payload)), target) {
				t.Fatal("invalid MCP Unicode reached application dispatch")
			}
		}
	}
}

func TestTemplateMCPDecodingPreservesValidUnicodeAndStrictFields(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		command string
		want    string
	}{
		{`"\ud83d\udcbb"`, "\U0001f4bb"},
		{`"\\ud800"`, `\ud800`},
		{`"\u4e2d\u6587"`, "\u4e2d\u6587"},
		{`"\ufffd"`, "\ufffd"},
	} {
		payload := []byte(`{"runtime":{"mcp_servers":[{"id":"documents","command":` + test.command + `}]}}`)
		var target createTemplateRequest
		if !decodeJSON(httptest.NewRecorder(), httptest.NewRequest("POST", "/", bytes.NewReader(payload)), &target) || target.Runtime.MCPServers[0].Command != test.want {
			t.Fatal("valid MCP Unicode changed or rejected")
		}
	}
	payload := []byte(`{"runtime":{"mcp_servers":[{"id":"documents","command":"node","url":"http://child"}]}}`)
	if decodeJSON(httptest.NewRecorder(), httptest.NewRequest("POST", "/", bytes.NewReader(payload)), &createTemplateRequest{}) {
		t.Fatal("unknown nested MCP field accepted")
	}
}
