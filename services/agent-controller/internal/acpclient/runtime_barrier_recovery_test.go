package acpclient_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const runtimeBarrierResponse = `{"organization_id":"org1","agent_id":"agent1","runtime_revision":"runtime1","barrier":{"barrier_id":"barrier1","reason":"runtime_barrier_required","runtime_execution_id":"retained-execution1"}}`

func runtimeBarrierQuery() ports.RuntimeBarrierQuery {
	return ports.RuntimeBarrierQuery{OrganizationID: "org1", AgentID: "agent1", ExpectedRuntimeRevision: "runtime1"}
}

func runtimeBarrierDocument(t *testing.T) map[string]any {
	t.Helper()
	var result map[string]any
	require.NoError(t, json.Unmarshal([]byte(runtimeBarrierResponse), &result))
	return result
}

func runtimeBarrierJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	require.NoError(t, err)
	return string(body)
}

func assertRuntimeBarrierDefinition(t *testing.T, definition string, payload []byte) {
	t.Helper()
	body, err := os.ReadFile("../../../../contracts/agent-acp/runtime-barrier-recovery.schema.json")
	require.NoError(t, err)
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	require.NoError(t, err)
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	const identifier = "https://antnest.local/contracts/agent-acp/runtime-barrier-recovery.schema.json"
	require.NoError(t, compiler.AddResource(identifier, document))
	// The document root is a result; request validation must select request.
	schema, err := compiler.Compile(identifier + "#/$defs/" + definition)
	require.NoError(t, err)
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	require.NoError(t, err)
	require.NoError(t, schema.Validate(instance))
}

func assertInvalidRuntimeBarrierResponse(t *testing.T, body, mediaType string) {
	t.Helper()
	var calls atomic.Int32
	client := newClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.Header().Set("Content-Type", mediaType)
		writer.WriteHeader(http.StatusOK)
		// A correct client may close an oversized or invalid response early.
		_, _ = io.WriteString(writer, body)
	})
	result, err := client.GetRuntimeBarrier(context.Background(), runtimeBarrierQuery())
	assertFailure(t, err, "invalid_response", true)
	require.Equal(t, ports.RuntimeBarrierResult{}, result, "an invalid response must not return a partial recovery fact")
	require.Equal(t, int32(1), calls.Load(), "a malformed response is never retried")
}

func TestGetRuntimeBarrierUsesFrozenRequestAndResponseContract(t *testing.T) {
	for _, hasBarrier := range []bool{false, true} {
		name := "no recovery fact"
		if hasBarrier {
			name = "durable recovery fact"
		}
		t.Run(name, func(t *testing.T) {
			query := runtimeBarrierQuery()
			wanted := ports.RuntimeBarrierResult{OrganizationID: query.OrganizationID, AgentID: query.AgentID, RuntimeRevision: query.ExpectedRuntimeRevision}
			document := runtimeBarrierDocument(t)
			if hasBarrier {
				wanted.Barrier = &ports.RuntimeBarrier{BarrierID: "barrier1", Reason: "runtime_barrier_required", RuntimeExecutionID: "retained-execution1"}
			} else {
				document["barrier"] = nil
			}
			response := runtimeBarrierJSON(t, document)
			assertRuntimeBarrierDefinition(t, "result", []byte(response))
			var calls atomic.Int32
			client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				require.Equal(t, http.MethodPost, request.Method)
				require.Equal(t, "/rpc/agent-acp/get-runtime-barrier", request.URL.Path)
				require.Empty(t, request.URL.RawQuery)
				require.Equal(t, "application/json", request.Header.Get("Content-Type"))
				require.Equal(t, "application/json", request.Header.Get("Accept"))
				body, err := io.ReadAll(request.Body)
				require.NoError(t, err)
				assertRuntimeBarrierDefinition(t, "request", body)
				var received map[string]any
				require.NoError(t, json.Unmarshal(body, &received))
				require.Equal(t, map[string]any{"organization_id": "org1", "agent_id": "agent1", "expected_runtime_revision": "runtime1"}, received)
				writeResponse(t, writer, http.StatusOK, response)
			})
			result, err := client.GetRuntimeBarrier(context.Background(), query)
			require.NoError(t, err)
			require.Equal(t, wanted, result)
			require.Equal(t, runtimeBarrierQuery(), query)
			require.Equal(t, int32(1), calls.Load())
			assertRuntimeBarrierDefinition(t, "result", []byte(runtimeBarrierJSON(t, result)))
			// A successful null is only an absent recovery fact. No receipt or
			// execution identity may be synthesized from the requested revision.
			if !hasBarrier {
				require.Nil(t, result.Barrier)
			}
		})
	}
}

func TestGetRuntimeBarrierPreservesOpaqueUnicodeIdentities(t *testing.T) {
	query := ports.RuntimeBarrierQuery{
		OrganizationID:          ":" + strings.Repeat("界", 199),
		AgentID:                 strings.Repeat("工", 200),
		ExpectedRuntimeRevision: strings.Repeat("e\u0301", 100),
	}
	// These are 200 Unicode characters, not 200 bytes or Controller IDs. The
	// literal replacement character is valid UTF-8 and must also be retained.
	barrierID := strings.Repeat("界", 198) + "/�"
	executionID := "旧:" + strings.Repeat("命", 198)
	wanted := ports.RuntimeBarrierResult{
		OrganizationID: query.OrganizationID, AgentID: query.AgentID, RuntimeRevision: query.ExpectedRuntimeRevision,
		Barrier: &ports.RuntimeBarrier{BarrierID: barrierID, Reason: "runtime_barrier_required", RuntimeExecutionID: executionID},
	}
	response := runtimeBarrierJSON(t, map[string]any{
		"organization_id": query.OrganizationID, "agent_id": query.AgentID, "runtime_revision": query.ExpectedRuntimeRevision,
		"barrier": map[string]any{"barrier_id": barrierID, "reason": "runtime_barrier_required", "runtime_execution_id": executionID},
	})
	assertRuntimeBarrierDefinition(t, "result", []byte(response))
	client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		assertRuntimeBarrierDefinition(t, "request", body)
		var received map[string]string
		require.NoError(t, json.Unmarshal(body, &received))
		require.Equal(t, map[string]string{"organization_id": query.OrganizationID, "agent_id": query.AgentID, "expected_runtime_revision": query.ExpectedRuntimeRevision}, received)
		writeResponse(t, writer, http.StatusOK, response)
	})
	result, err := client.GetRuntimeBarrier(context.Background(), query)
	require.NoError(t, err)
	require.Equal(t, wanted, result, "opaque identities must not be trimmed, normalized, or compared to a health-derived execution ID")
}

func TestGetRuntimeBarrierRejectsInvalidQueriesBeforeHTTP(t *testing.T) {
	invalid := []struct {
		name  string
		value string
	}{
		{"empty", ""},
		{"space", " "},
		{"leading space", " org1"},
		{"trailing space", "org1 "},
		{"internal space", "org 1"},
		{"tab", "org\t1"},
		{"newline", "org\n1"},
		{"201 ASCII characters", strings.Repeat("a", 201)},
		{"201 Unicode characters", strings.Repeat("界", 201)},
		{"invalid UTF-8", "org\xff1"},
	}
	for _, field := range []string{"organization_id", "agent_id", "expected_runtime_revision"} {
		for _, test := range invalid {
			t.Run(field+"/"+test.name, func(t *testing.T) {
				var calls atomic.Int32
				transport := transportFunc(func(*http.Request) (*http.Response, error) {
					calls.Add(1)
					return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(runtimeBarrierResponse))}, nil
				})
				client, err := acpclient.New("http://acp.internal", time.Second, &http.Client{Transport: transport})
				require.NoError(t, err)
				query := runtimeBarrierQuery()
				switch field {
				case "organization_id":
					query.OrganizationID = test.value
				case "agent_id":
					query.AgentID = test.value
				case "expected_runtime_revision":
					query.ExpectedRuntimeRevision = test.value
				}
				result, err := client.GetRuntimeBarrier(context.Background(), query)
				require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierQuery)
				require.Equal(t, ports.RuntimeBarrierResult{}, result)
				require.Zero(t, calls.Load())
			})
		}
	}
}

func TestGetRuntimeBarrierRequiresExactRequestedScope(t *testing.T) {
	for _, field := range []string{"organization_id", "agent_id", "runtime_revision"} {
		for _, hasBarrier := range []bool{false, true} {
			name := "null"
			if hasBarrier {
				name = "receipt"
			}
			t.Run(field+"/"+name, func(t *testing.T) {
				document := runtimeBarrierDocument(t)
				document[field] = "different-valid-identity"
				if !hasBarrier {
					document["barrier"] = nil
				}
				assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
			})
		}
	}
}

func TestGetRuntimeBarrierRequiresEveryResponseField(t *testing.T) {
	for _, field := range []string{"organization_id", "agent_id", "runtime_revision", "barrier"} {
		t.Run("top-level/"+field, func(t *testing.T) {
			document := runtimeBarrierDocument(t)
			delete(document, field)
			assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
		})
	}
	for _, field := range []string{"barrier_id", "reason", "runtime_execution_id"} {
		t.Run("barrier/"+field, func(t *testing.T) {
			document := runtimeBarrierDocument(t)
			delete(document["barrier"].(map[string]any), field)
			assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
		})
	}
}

func TestGetRuntimeBarrierRejectsUnknownFieldsAndCaseAliases(t *testing.T) {
	for _, nested := range []bool{false, true} {
		fields := []string{"organization_id", "agent_id", "runtime_revision", "barrier"}
		prefix := "top-level"
		if nested {
			fields = []string{"barrier_id", "reason", "runtime_execution_id"}
			prefix = "barrier"
		}
		for _, field := range append(fields, "unknown") {
			t.Run(prefix+"/"+field, func(t *testing.T) {
				document := runtimeBarrierDocument(t)
				target := document
				if nested {
					target = document["barrier"].(map[string]any)
				}
				if field == "unknown" {
					target["unknown"] = "synthetic-private-field"
				} else {
					target[strings.ToUpper(field)] = target[field]
					delete(target, field)
				}
				assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
			})
		}
	}
	for _, nested := range []bool{false, true} {
		t.Run(map[bool]string{false: "top-level valid plus case alias", true: "barrier valid plus case alias"}[nested], func(t *testing.T) {
			document := runtimeBarrierDocument(t)
			if nested {
				document["barrier"].(map[string]any)["Barrier_ID"] = "barrier1"
			} else {
				document["Organization_ID"] = "org1"
			}
			assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
		})
	}
}

func TestGetRuntimeBarrierRejectsDuplicateKeysAndMalformedJSON(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"empty", ""},
		{"null", "null"},
		{"array", "[]"},
		{"string", `"receipt"`},
		{"boolean", "false"},
		{"number", "1"},
		{"truncated", runtimeBarrierResponse[:len(runtimeBarrierResponse)-1]},
		{"trailing object", runtimeBarrierResponse + " {}"},
		{"trailing null", runtimeBarrierResponse + " null"},
		{"trailing garbage", runtimeBarrierResponse + " !"},
		{"UTF-8 BOM", "\xef\xbb\xbf" + runtimeBarrierResponse},
		{"invalid UTF-8 barrier identity", strings.Replace(runtimeBarrierResponse, "barrier1", "barrier\xff1", 1)},
		{"invalid UTF-8 execution identity", strings.Replace(runtimeBarrierResponse, "retained-execution1", "retained-execution\xff1", 1)},
		{"duplicate organization", strings.Replace(runtimeBarrierResponse, `"organization_id":"org1"`, `"organization_id":"org1","organization_id":"org1"`, 1)},
		{"decoded duplicate organization", strings.Replace(runtimeBarrierResponse, `"organization_id":"org1"`, `"organization_id":"org1","organization_\u0069d":"org1"`, 1)},
		{"decoded duplicate Agent", strings.Replace(runtimeBarrierResponse, `"agent_id":"agent1"`, `"agent_id":"agent1","agent_\u0069d":"agent1"`, 1)},
		{"decoded duplicate Runtime revision", strings.Replace(runtimeBarrierResponse, `"runtime_revision":"runtime1"`, `"runtime_revision":"runtime1","runtime_revisio\u006e":"runtime1"`, 1)},
		{"duplicate barrier null then receipt", strings.Replace(runtimeBarrierResponse, `"barrier":`, `"barrier":null,"barrier":`, 1)},
		{"decoded duplicate barrier", strings.Replace(runtimeBarrierResponse, `"barrier":`, `"barrie\u0072":null,"barrier":`, 1)},
		{"nested duplicate barrier identity", strings.Replace(runtimeBarrierResponse, `"barrier_id":"barrier1"`, `"barrier_id":"barrier1","barrier_id":"barrier1"`, 1)},
		{"nested decoded duplicate barrier identity", strings.Replace(runtimeBarrierResponse, `"barrier_id":"barrier1"`, `"barrier_id":"barrier1","barrier_\u0069d":"barrier1"`, 1)},
		{"nested duplicate reason last value valid", strings.Replace(runtimeBarrierResponse, `"reason":"runtime_barrier_required"`, `"reason":"wrong","reason":"runtime_barrier_required"`, 1)},
		{"nested decoded duplicate reason", strings.Replace(runtimeBarrierResponse, `"reason":"runtime_barrier_required"`, `"reason":"runtime_barrier_required","reaso\u006e":"runtime_barrier_required"`, 1)},
		{"nested decoded duplicate execution identity", strings.Replace(runtimeBarrierResponse, `"runtime_execution_id":"retained-execution1"`, `"runtime_execution_id":"retained-execution1","runtime_execution_\u0069d":"retained-execution1"`, 1)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			assertInvalidRuntimeBarrierResponse(t, test.body, "application/json")
		})
	}
}

func TestGetRuntimeBarrierRejectsInvalidResponseIdentitiesAndTypes(t *testing.T) {
	invalid := []struct {
		name  string
		value any
	}{
		{"null", nil},
		{"number", 1},
		{"boolean", false},
		{"array", []any{}},
		{"object", map[string]any{}},
		{"empty", ""},
		{"leading whitespace", " identity"},
		{"trailing whitespace", "identity "},
		{"internal whitespace", "iden tity"},
		{"tab", "iden\ttity"},
		{"newline", "iden\ntity"},
		{"201 ASCII characters", strings.Repeat("x", 201)},
		{"201 Unicode characters", strings.Repeat("界", 201)},
	}
	for _, field := range []string{"organization_id", "agent_id", "runtime_revision", "barrier_id", "runtime_execution_id"} {
		for _, test := range invalid {
			t.Run(field+"/"+test.name, func(t *testing.T) {
				document := runtimeBarrierDocument(t)
				target := document
				if field == "barrier_id" || field == "runtime_execution_id" {
					target = document["barrier"].(map[string]any)
				}
				target[field] = test.value
				assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
			})
		}
	}
	for _, value := range []any{"receipt", 1, false, []any{}} {
		t.Run("barrier wrong type/"+runtimeBarrierJSON(t, value), func(t *testing.T) {
			document := runtimeBarrierDocument(t)
			document["barrier"] = value
			assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
		})
	}
	for _, value := range []any{nil, 1, false, []any{}, map[string]any{}, "", "runtime_unhealthy", "RUNTIME_BARRIER_REQUIRED", "runtime_barrier_required "} {
		t.Run("reason/"+runtimeBarrierJSON(t, value), func(t *testing.T) {
			document := runtimeBarrierDocument(t)
			document["barrier"].(map[string]any)["reason"] = value
			assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
		})
	}
}

func TestGetRuntimeBarrierEnforcesResponseMediaAndByteBudget(t *testing.T) {
	for _, mediaType := range []string{"", "text/plain", "text/json", "application/problem+json", "application/json; charset"} {
		t.Run("invalid media/"+mediaType, func(t *testing.T) {
			assertInvalidRuntimeBarrierResponse(t, runtimeBarrierResponse, mediaType)
		})
	}
	t.Run("UTF-8 JSON media parameter", func(t *testing.T) {
		client := newClient(t, func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, err := io.WriteString(writer, runtimeBarrierResponse)
			require.NoError(t, err)
		})
		result, err := client.GetRuntimeBarrier(context.Background(), runtimeBarrierQuery())
		require.NoError(t, err)
		require.NotNil(t, result.Barrier)
		require.Equal(t, "retained-execution1", result.Barrier.RuntimeExecutionID)
	})
	const limit = 1 << 20
	for _, size := range []int{limit, limit + 1} {
		name := "exactly 1 MiB is accepted"
		if size > limit {
			name = "over 1 MiB is rejected even with valid JSON and whitespace"
		}
		t.Run(name, func(t *testing.T) {
			body := runtimeBarrierResponse + strings.Repeat(" ", size-len(runtimeBarrierResponse))
			if size > limit {
				assertInvalidRuntimeBarrierResponse(t, body, "application/json")
				return
			}
			client := newClient(t, func(writer http.ResponseWriter, _ *http.Request) { writeResponse(t, writer, http.StatusOK, body) })
			result, err := client.GetRuntimeBarrier(context.Background(), runtimeBarrierQuery())
			require.NoError(t, err)
			require.NotNil(t, result.Barrier)
			require.Equal(t, "barrier1", result.Barrier.BarrierID)
		})
	}
}

func assertRuntimeBarrierOpaqueRoundTrip(t *testing.T, identity, encodedIdentity string) {
	t.Helper()
	query := runtimeBarrierQuery()
	query.ExpectedRuntimeRevision = identity
	response := strings.Replace(runtimeBarrierResponse, `"runtime1"`, encodedIdentity, 1)
	response = strings.Replace(response, `"barrier1"`, encodedIdentity, 1)
	response = strings.Replace(response, `"retained-execution1"`, encodedIdentity, 1)
	assertRuntimeBarrierDefinition(t, "result", []byte(response))
	client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		assertRuntimeBarrierDefinition(t, "request", body)
		var received map[string]string
		require.NoError(t, json.Unmarshal(body, &received))
		require.Equal(t, map[string]string{"organization_id": query.OrganizationID, "agent_id": query.AgentID, "expected_runtime_revision": identity}, received)
		writeResponse(t, writer, http.StatusOK, response)
	})
	result, err := client.GetRuntimeBarrier(context.Background(), query)
	require.NoError(t, err)
	require.Equal(t, ports.RuntimeBarrierResult{
		OrganizationID: query.OrganizationID, AgentID: query.AgentID, RuntimeRevision: identity,
		Barrier: &ports.RuntimeBarrier{BarrierID: identity, Reason: "runtime_barrier_required", RuntimeExecutionID: identity},
	}, result)
}

func assertInvalidRuntimeBarrierQueryBeforeHTTP(t *testing.T, query ports.RuntimeBarrierQuery) {
	t.Helper()
	var calls atomic.Int32
	transport := transportFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(runtimeBarrierResponse))}, nil
	})
	client, err := acpclient.New("http://acp.internal", time.Second, &http.Client{Transport: transport})
	require.NoError(t, err)
	result, err := client.GetRuntimeBarrier(context.Background(), query)
	require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierQuery)
	require.Equal(t, ports.RuntimeBarrierResult{}, result)
	require.Zero(t, calls.Load())
}

func TestGetRuntimeBarrierCountsSupplementaryCodepoints(t *testing.T) {
	t.Run("200 supplementary codepoints survive request and response", func(t *testing.T) {
		identity := strings.Repeat("🧪", 200)
		assertRuntimeBarrierOpaqueRoundTrip(t, identity, runtimeBarrierJSON(t, identity))
	})
	t.Run("201 supplementary codepoints reject request before HTTP", func(t *testing.T) {
		query := runtimeBarrierQuery()
		query.ExpectedRuntimeRevision = strings.Repeat("🧪", 201)
		assertInvalidRuntimeBarrierQueryBeforeHTTP(t, query)
	})
	t.Run("201 supplementary codepoints reject response", func(t *testing.T) {
		document := runtimeBarrierDocument(t)
		document["barrier"].(map[string]any)["barrier_id"] = strings.Repeat("🧪", 201)
		assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
	})
}

func TestGetRuntimeBarrierAcceptsFrozenNonWhitespaceControls(t *testing.T) {
	// ECMAScript whitespace excludes NEL, DEL and these C0 controls. JSON
	// escapes preserve the original opaque identities rather than normalizing.
	allowed := []rune{0x0085, 0x007f}
	for value := rune(0); value <= 0x0008; value++ {
		allowed = append(allowed, value)
	}
	for value := rune(0x000e); value <= 0x001f; value++ {
		allowed = append(allowed, value)
	}
	for _, value := range allowed {
		t.Run(fmt.Sprintf("U+%04X", value), func(t *testing.T) {
			identity := "x" + string(value) + "y"
			encodedIdentity := fmt.Sprintf(`"x\u%04xy"`, value)
			assertRuntimeBarrierOpaqueRoundTrip(t, identity, encodedIdentity)
		})
	}
}

func TestGetRuntimeBarrierRejectsEveryECMAScriptWhitespace(t *testing.T) {
	whitespace := []rune{0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680}
	for value := rune(0x2000); value <= 0x200a; value++ {
		whitespace = append(whitespace, value)
	}
	whitespace = append(whitespace, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff)
	for _, value := range whitespace {
		t.Run(fmt.Sprintf("U+%04X", value), func(t *testing.T) {
			identity := "x" + string(value) + "y"
			query := runtimeBarrierQuery()
			query.ExpectedRuntimeRevision = identity
			assertInvalidRuntimeBarrierQueryBeforeHTTP(t, query)
			document := runtimeBarrierDocument(t)
			document["barrier"].(map[string]any)["runtime_execution_id"] = identity
			assertInvalidRuntimeBarrierResponse(t, runtimeBarrierJSON(t, document), "application/json")
		})
	}
}

func TestGetRuntimeBarrierPreservesRawJSONUnicodeIdentities(t *testing.T) {
	// These bytes must reach the new query's decoder unchanged. Marshaling a
	// Go string first would conceal the isolated-surrogate escape under test.
	for _, field := range []struct {
		name     string
		original string
	}{
		{"barrier_id", `"barrier1"`},
		{"runtime_execution_id", `"retained-execution1"`},
	} {
		for _, surrogate := range []struct {
			name string
			raw  string
		}{
			{"isolated high surrogate", `"\ud800"`},
			{"isolated low surrogate", `"\udfff"`},
		} {
			t.Run(field.name+"/"+surrogate.name, func(t *testing.T) {
				response := strings.Replace(runtimeBarrierResponse, field.original, surrogate.raw, 1)
				assertInvalidRuntimeBarrierResponse(t, response, "application/json")
			})
		}
	}
	for _, test := range []struct {
		name     string
		raw      string
		identity string
	}{
		{"paired supplementary escape", `"\ud83e\uddea"`, "🧪"},
		{"literal supplementary codepoint", `"🧪"`, "🧪"},
		{"literal replacement character", `"�"`, "�"},
		{"escaped replacement character", `"\ufffd"`, "�"},
		{"literal backslash high surrogate text", `"\\ud800"`, `\ud800`},
		{"literal backslash low surrogate text", `"\\udfff"`, `\udfff`},
		{"escaped backslash high surrogate text", `"\u005cud800"`, `\ud800`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := strings.Replace(runtimeBarrierResponse, `"barrier1"`, test.raw, 1)
			response = strings.Replace(response, `"retained-execution1"`, test.raw, 1)
			assertRuntimeBarrierDefinition(t, "result", []byte(response))
			client := newClient(t, func(writer http.ResponseWriter, _ *http.Request) {
				writeResponse(t, writer, http.StatusOK, response)
			})
			result, err := client.GetRuntimeBarrier(context.Background(), runtimeBarrierQuery())
			require.NoError(t, err)
			require.Equal(t, ports.RuntimeBarrierResult{
				OrganizationID: "org1", AgentID: "agent1", RuntimeRevision: "runtime1",
				Barrier: &ports.RuntimeBarrier{BarrierID: test.identity, Reason: "runtime_barrier_required", RuntimeExecutionID: test.identity},
			}, result, "valid JSON escapes must preserve the original opaque identities")
		})
	}
}
