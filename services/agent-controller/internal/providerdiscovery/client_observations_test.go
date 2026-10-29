package providerdiscovery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func listOneModel(t *testing.T, body string) Model {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[` + body + `]}`))
	}))
	defer upstream.Close()
	models, err := fixtureClient(t, time.Second).ListModels(context.Background(), Connection{ProviderKey: "openrouter", BaseURL: upstream.URL}, "key")
	if err != nil || len(models) != 1 {
		t.Fatalf("optional metadata must not fail a wellformed list: models=%+v err=%v", models, err)
	}
	return models[0]
}

func TestOptionalTokenDimensionsDecodeIndependently(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		body      string
		wantCtx   *int
		wantOut   *int
		wantTools *bool
	}{
		{"valid limits", `{"id":"m","context_length":128000,"top_provider":{"max_completion_tokens":8192}}`, ints(128000), ints(8192), nil},
		{"context only", `{"id":"m","context_length":128000}`, ints(128000), nil, nil},
		{"output only", `{"id":"m","top_provider":{"max_completion_tokens":8192}}`, nil, ints(8192), nil},
		{"safe max", `{"id":"m","context_length":9007199254740991}`, ints(9007199254740991), nil, nil},
		{"malformed context keeps output", `{"id":"m","context_length":"128000","top_provider":{"max_completion_tokens":8192}}`, nil, ints(8192), nil},
		{"malformed output keeps context", `{"id":"m","context_length":128000,"top_provider":{"max_completion_tokens":"8192"}}`, ints(128000), nil, nil},
		{"malformed top_provider keeps context", `{"id":"m","context_length":128000,"top_provider":"bad"}`, ints(128000), nil, nil},
		{"null top_provider", `{"id":"m","top_provider":null}`, nil, nil, nil},
		{"zero", `{"id":"m","context_length":0}`, nil, nil, nil},
		{"negative", `{"id":"m","context_length":-5}`, nil, nil, nil},
		{"fraction", `{"id":"m","context_length":1.5}`, nil, nil, nil},
		{"string", `{"id":"m","context_length":"128000"}`, nil, nil, nil},
		{"bool", `{"id":"m","context_length":true}`, nil, nil, nil},
		{"null", `{"id":"m","context_length":null}`, nil, nil, nil},
		{"overflow", `{"id":"m","context_length":9007199254740993}`, nil, nil, nil},
		{"tools present", `{"id":"m","supported_parameters":["tools"]}`, nil, nil, bools(true)},
		{"tools absent from valid array", `{"id":"m","supported_parameters":["response_format","seed"]}`, nil, nil, bools(false)},
		{"empty array is valid without tools", `{"id":"m","supported_parameters":[]}`, nil, nil, bools(false)},
		{"parameters absent", `{"id":"m"}`, nil, nil, nil},
		{"parameters null", `{"id":"m","supported_parameters":null}`, nil, nil, nil},
		{"parameters malformed", `{"id":"m","supported_parameters":"tools"}`, nil, nil, nil},
		{"parameters non-string elements", `{"id":"m","supported_parameters":[1]}`, nil, nil, nil},
		{"parameters null element", `{"id":"m","supported_parameters":[null]}`, nil, nil, nil},
		{"tools plus null element unknown", `{"id":"m","supported_parameters":["tools",null]}`, nil, nil, nil},
		{"quoted string not a number", `{"id":"m","context_length":"128000","top_provider":{"max_completion_tokens":"8192"}}`, nil, nil, nil},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			model := listOneModel(t, scenario.body)
			if !intPtrEqual(model.ContextWindow, scenario.wantCtx) || !intPtrEqual(model.MaxOutputTokens, scenario.wantOut) || !boolPtrEqual(model.SupportsTools, scenario.wantTools) {
				t.Fatalf("decoded ctx=%v out=%v tools=%v", model.ContextWindow, model.MaxOutputTokens, model.SupportsTools)
			}
		})
	}
}

func TestOptionalMetadataNeverClaimsMediaOrReasoning(t *testing.T) {
	model := listOneModel(t, `{"id":"m","context_length":128000,"supported_parameters":["tools","logprobs"]}`)
	if model.SupportsTools == nil || !*model.SupportsTools {
		t.Fatalf("tools not proven: %+v", model.SupportsTools)
	}
}

func ints(value int) *int    { return &value }
func bools(value bool) *bool { return &value }

func intPtrEqual(actual, expected *int) bool {
	if actual == nil || expected == nil {
		return actual == expected
	}
	return *actual == *expected
}

func boolPtrEqual(actual, expected *bool) bool {
	if actual == nil || expected == nil {
		return actual == expected
	}
	return *actual == *expected
}
