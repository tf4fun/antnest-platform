package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func preconditionRequest(t *testing.T, body string, ifMatch ...string) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPut, "/internal/test", strings.NewReader(body))
	for _, value := range ifMatch {
		request.Header.Add("If-Match", value)
	}
	return httptest.NewRecorder(), request
}

func TestContractConventionsDecodeJSONAcceptedPreconditions(t *testing.T) {
	t.Parallel()

	networkBody := `{"request_id":"request-1","organization_id":"org-1","actor_principal_id":"admin-1","policy_id":"builtin/allow-all","revision":1,"expected_resource_version":7}`
	networkCanonical := strings.Replace(networkBody, `"expected_resource_version":7`, `"expected_version":"7"`, 1)
	networkIfMatch := strings.Replace(networkBody, `,"expected_resource_version":7`, ``, 1)
	learningRevision := strings.Repeat("a", 64)
	for _, scenario := range []struct {
		name     string
		target   func() any
		body     string
		ifMatch  []string
		validate func(t *testing.T, decoded any)
	}{
		{"model profile canonical", func() any { return &reviseModelProfileRequest{} },
			`{"expected_version":"7","request_id":"r1","organization_id":"org-1","display_name":"n","model":{"model":"deepseek-chat","context_window":128000,"max_output_tokens":8192,"supports_images":false}}`,
			nil, func(t *testing.T, d any) {
				if d.(*reviseModelProfileRequest).ExpectedVersion != 7 {
					t.Fatalf("expected_version=%+v", d)
				}
			}},
		{"model profile legacy number", func() any { return &reviseModelProfileRequest{} },
			`{"expected_version":7,"request_id":"r1","organization_id":"org-1","display_name":"n","model":{"model":"deepseek-chat","context_window":128000,"max_output_tokens":8192,"supports_images":false}}`,
			nil, func(t *testing.T, d any) {
				if d.(*reviseModelProfileRequest).ExpectedVersion != 7 {
					t.Fatalf("expected_version=%+v", d)
				}
			}},
		{"model profile if-match", func() any { return &reviseModelProfileRequest{} },
			`{"request_id":"r1","organization_id":"org-1","display_name":"n","model":{"model":"deepseek-chat","context_window":128000,"max_output_tokens":8192,"supports_images":false}}`,
			[]string{`"7"`}, func(t *testing.T, d any) {
				if d.(*reviseModelProfileRequest).ExpectedVersion != 7 {
					t.Fatalf("expected_version=%+v", d)
				}
			}},
		{"credential opaque", func() any { return &rotateProviderCredentialRequest{} },
			`{"expected_version":"tok-3","request_id":"r1","organization_id":"org-1","credential":{"method":"api_key","api_key":"synthetic1234"}}`,
			nil, func(t *testing.T, d any) {
				if d.(*rotateProviderCredentialRequest).ExpectedVersion != "tok-3" {
					t.Fatalf("expected_version=%+v", d)
				}
			}},
		{"model call canonical", func() any { return &application.SetModelCallPolicyInput{} },
			`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3"}`,
			nil, func(t *testing.T, d any) {
				if v := d.(*application.SetModelCallPolicyInput).ExpectedRevision; v == nil || *v != 3 {
					t.Fatalf("expected_revision=%+v", v)
				}
			}},
		{"model call legacy explicit zero", func() any { return &application.SetModelCallPolicyInput{} },
			`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_revision":0}`,
			nil, func(t *testing.T, d any) {
				if v := d.(*application.SetModelCallPolicyInput).ExpectedRevision; v == nil || *v != 0 {
					t.Fatalf("expected_revision=%+v", v)
				}
			}},
		{"recovery canonical", func() any { return &application.SetRuntimeBarrierRecoveryPolicyInput{} },
			`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"4","mode":"observe","cooldown_ms":10}`,
			nil, func(t *testing.T, d any) {
				if v := d.(*application.SetRuntimeBarrierRecoveryPolicyInput).ExpectedRevision; v == nil || *v != 4 {
					t.Fatalf("expected_revision=%+v", v)
				}
			}},
		{"learning canonical", func() any { return &application.SetSkillLearningPolicyInput{} },
			`{"request_id":"req-learn-00000001","organization_id":"org-1","actor_principal_id":"a1","expected_version":"` + learningRevision + `"}`,
			nil, func(t *testing.T, d any) {
				if d.(*application.SetSkillLearningPolicyInput).ExpectedRevision != learningRevision {
					t.Fatalf("expected_revision=%+v", d)
				}
			}},
		{"network canonical", func() any { return &application.SetAgentNetworkPolicyInput{} }, networkCanonical,
			nil, func(t *testing.T, d any) {
				if d.(*application.SetAgentNetworkPolicyInput).ExpectedResourceVersion != 7 {
					t.Fatalf("expected_resource_version=%+v", d)
				}
			}},
		{"network legacy", func() any { return &application.SetAgentNetworkPolicyInput{} }, networkBody,
			nil, func(t *testing.T, d any) {
				if d.(*application.SetAgentNetworkPolicyInput).ExpectedResourceVersion != 7 {
					t.Fatalf("expected_resource_version=%+v", d)
				}
			}},
		{"network if-match", func() any { return &application.SetAgentNetworkPolicyInput{} }, networkIfMatch,
			[]string{`"7"`}, func(t *testing.T, d any) {
				if d.(*application.SetAgentNetworkPolicyInput).ExpectedResourceVersion != 7 {
					t.Fatalf("expected_resource_version=%+v", d)
				}
			}},
	} {
		response, request := preconditionRequest(t, scenario.body, scenario.ifMatch...)
		target := scenario.target()
		if !decodeJSON(response, request, target) {
			t.Fatalf("%s: status=%d body=%s", scenario.name, response.Code, response.Body.String())
		}
		scenario.validate(t, target)
	}
}

func TestContractConventionsSpecPolicyPortsPreserveStrictCustomDecoding(t *testing.T) {
	for _, port := range []string{`443`, `{"from":443,"to":443}`} {
		for _, version := range []string{`"expected_version":"7"`, `"expected_resource_version":7`, ""} {
			body := `{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[` + port + `]}]}`
			var headers []string
			if version == "" {
				headers = []string{`"7"`}
			} else {
				body += "," + version
			}
			response, request := preconditionRequest(t, body+"}", headers...)
			var input application.SetAgentNetworkPolicyInput
			if !decodeJSON(response, request, &input) {
				t.Fatalf("port=%s version=%s: %s", port, version, response.Body.String())
			}
			got := input.Spec.Rules[0].Ports[0]
			if input.ExpectedResourceVersion != 7 || got.From != 443 || got.To != 443 || got.Range != strings.HasPrefix(port, "{") {
				t.Fatalf("lost version or port shape: %+v %+v", input, got)
			}
		}
	}
	for _, port := range []string{`{"from":443,"to":443,"unknown":1}`, `{"from":443,"from":443,"to":443}`, `{"From":443,"to":443}`, `null`} {
		body := `{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"7","spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[` + port + `]}]}}`
		response, request := preconditionRequest(t, body)
		var input application.SetAgentNetworkPolicyInput
		if decodeJSON(response, request, &input) || response.Code != http.StatusBadRequest {
			t.Fatalf("invalid port accepted: %s", port)
		}
	}
}

func TestContractConventionsDecodeJSONRejectsMalformedPreconditions(t *testing.T) {
	t.Parallel()

	rejection := func(target any, body string, ifMatch ...string) {
		t.Helper()
		response, request := preconditionRequest(t, body, ifMatch...)
		if decodeJSON(response, request, target) || response.Code != http.StatusBadRequest {
			t.Fatalf("body=%s headers=%v accepted status=%d", body, ifMatch, response.Code)
		}
	}
	revision := func(target func() any) func(string, ...string) {
		return func(body string, ifMatch ...string) { rejection(target(), body, ifMatch...) }
	}
	modelCall := revision(func() any { return &application.SetModelCallPolicyInput{} })
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":null}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3","expected_revision":3}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3","expected_revision":5}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"-3"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3.5"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3e2"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"03"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":" 3"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"99999999999999999999999"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":3.5}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3","expected_version":"3"}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3"}`, `"3"`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","expected_version":"3","extra":1}`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `"3"`, `"3"`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `W/"3"`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `*`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `3`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `"3", "4"`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `""`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `"`+strings.Repeat("a", 129)+`"`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `"a\\b"`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `"a\tb"`)
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, "\"a\x00b\"")
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, "\"a\x7fb\"")
	modelCall(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1"}`, `"`+strings.Repeat("ü", 65)+`"`)

	credential := revision(func() any { return &rotateProviderCredentialRequest{} })
	credential(`{"request_id":"r1","organization_id":"org-1","credential":{"method":"api_key","api_key":"synthetic1234"}}`, "\"to\tk\"")
	credential(`{"request_id":"r1","organization_id":"org-1","credential":{"method":"api_key","api_key":"synthetic1234"}}`, "\"tok\x00en\"")
	credential(`{"request_id":"r1","organization_id":"org-1","credential":{"method":"api_key","api_key":"synthetic1234"}}`, "\"tok\x7fen\"")
	credential(`{"request_id":"r1","organization_id":"org-1","credential":{"method":"api_key","api_key":"synthetic1234"}}`, `"`+strings.Repeat("ü", 65)+`"`)

	profile := revision(func() any { return &reviseModelProfileRequest{} })
	profile(`{"expected_version":"-1"}`)
	profile(`{"expected_version":1e3}`)
	profile(`{"expected_version":"abc"}`)
	profile(`{"expected_version":"` + strings.Repeat("9", 21) + `"}`)

	credential(`{"expected_version":3}`)
	credential(`{"expected_version":""}`)
	credential(`{"expected_version":"` + strings.Repeat("a", 129) + `"}`)

	network := revision(func() any { return &application.SetAgentNetworkPolicyInput{} })
	network(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","policy_id":"p","revision":1,"expected_version":"18446744073709551616"}`)
	network(`{"request_id":"r1","organization_id":"org-1","actor_principal_id":"a1","policy_id":"p","revision":1,"expected_version":"7","expected_resource_version":7}`)
}

func TestContractConventionsNetworkPolicyAcceptsCanonicalAndLegacy(t *testing.T) {
	t.Parallel()

	legacy := `{"request_id":"request-1","organization_id":"org-1","actor_principal_id":"admin-1","policy_id":"builtin/allow-all","revision":1,"expected_resource_version":7}`
	canonical := strings.Replace(legacy, `"expected_resource_version":7`, `"expected_version":"7"`, 1)
	header := strings.Replace(legacy, `,"expected_resource_version":7`, ``, 1)
	for _, scenario := range []struct {
		name    string
		body    string
		ifMatch string
	}{
		{"canonical", canonical, ""}, {"legacy", legacy, ""}, {"if-match", header, `"7"`},
	} {
		service := &networkPolicyServiceStub{}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(scenario.body))
		if scenario.ifMatch != "" {
			request.Header.Set("If-Match", scenario.ifMatch)
		}
		networkHandler(t, service).ServeHTTP(response, request)
		if response.Code != 200 || len(service.writes) != 1 || service.writes[0].ExpectedResourceVersion != 7 {
			t.Fatalf("%s: response=%d %s writes=%+v", scenario.name, response.Code, response.Body.String(), service.writes)
		}
	}
	service := &networkPolicyServiceStub{}
	response := httptest.NewRecorder()
	networkHandler(t, service).ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/internal/agents/agent-1/network-policy",
		strings.NewReader(strings.Replace(legacy, `"expected_resource_version":7`, `"expected_resource_version":7,"expected_version":"7"`, 1))))
	if response.Code != http.StatusBadRequest || len(service.writes) != 0 {
		t.Fatalf("conflicting aliases: response=%d writes=%+v", response.Code, service.writes)
	}
}

func TestContractConventionsCatalogListsCanonicalCursorAndLegacyAlias(t *testing.T) {
	t.Parallel()

	compiler := compileControlSchema(t, filepath.Join(repositoryRoot(t), "contracts/agent-controller/control-api.ids-v2.schema.json"))
	schema, err := compiler.Compile("https://schemas.antnest.dev/agent-controller/control-api.ids-v2.schema.json#/$defs/agent_template_list")
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct{ name, query, wantAfter string }{
		{"canonical cursor", "cursor=template-0", "template-0"},
		{"legacy after_id", "after_id=template-0", "template-0"},
	} {
		service := &catalogServiceStub{templatePage: application.TemplatePage{
			Items: []application.TemplateView{sampleTemplateView()}, NextAfterID: "template-1",
		}}
		handler, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet,
			"/internal/agent-templates?organization_id=org-1&limit=20&"+scenario.query, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status=%d %s", scenario.name, response.Code, response.Body.String())
		}
		if service.listInput != (application.ListCatalogInput{OrganizationID: "org-1", AfterID: scenario.wantAfter, Limit: 20}) {
			t.Fatalf("%s: list input = %+v", scenario.name, service.listInput)
		}
		var value map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		if _, banned := value["next_after_id"]; banned {
			t.Fatalf("%s: legacy next_after_id in response %s", scenario.name, response.Body.String())
		}
		if err := schema.Validate(value); err != nil {
			t.Fatalf("%s: response schema: %v", scenario.name, err)
		}
	}
	for _, query := range []string{
		"organization_id=org-1&cursor=a&cursor=b",
		"organization_id=org-1&cursor=a&after_id=b",
		"organization_id=org-1&cursor=",
		"organization_id=org-1&after_id=",
		"organization_id=org-1&cursor=" + strings.Repeat("a", 4097),
		"organization_id=org-1&limit=0",
		"organization_id=org-1&limit=501",
		"organization_id=org-1&unknown=x",
	} {
		service := &catalogServiceStub{}
		handler, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agent-templates?"+query, nil))
		if response.Code != http.StatusBadRequest || service.listInput != (application.ListCatalogInput{}) {
			t.Fatalf("query=%q status=%d input=%+v", query, response.Code, service.listInput)
		}
	}
}

func TestContractConventionsListResponsesEmitOnlyCanonicalCursor(t *testing.T) {
	t.Parallel()

	for _, scenario := range []struct {
		name   string
		path   string
		page   func(*catalogServiceStub)
		field  string
		absent string
	}{
		{"providers", "/internal/provider-connections?organization_id=org-1",
			func(s *catalogServiceStub) {
				s.providerPage = &application.ProviderConnectionPage{NextAfterID: "conn-2"}
			}, "next_cursor", "next_after_id"},
		{"providers end", "/internal/provider-connections?organization_id=org-1",
			func(s *catalogServiceStub) {
				s.providerPage = &application.ProviderConnectionPage{}
			}, "", "next_after_id"},
	} {
		service := &catalogServiceStub{}
		scenario.page(service)
		handler, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, scenario.path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status=%d %s", scenario.name, response.Code, response.Body.String())
		}
		var value map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		if _, banned := value[scenario.absent]; banned {
			t.Fatalf("%s: legacy field emitted %s", scenario.name, response.Body.String())
		}
		if scenario.field != "" {
			if value[scenario.field] != "conn-2" {
				t.Fatalf("%s: next_cursor=%v", scenario.name, value[scenario.field])
			}
		}
	}
}

func TestContractConventionsRecoveryPolicyCanonicalAndIfMatch(t *testing.T) {
	t.Parallel()

	base := `{"request_id":"policy-change-1","organization_id":"org-1","actor_principal_id":"user-admin","mode":"manual","cooldown_ms":300000}`
	for _, scenario := range []struct {
		name, body, ifMatch string
	}{
		{"canonical body", `{"expected_version":"0",` + base[1:], ""},
		{"legacy body", `{"expected_revision":0,` + base[1:], ""},
		{"if-match zero", base, `"0"`},
	} {
		stub := &runtimeBarrierRecoveryPolicyServiceStub{policy: domain.RuntimeBarrierRecoveryPolicy{
			OrganizationID: "org-1", Revision: 0, Mode: "manual", CooldownMS: 300000,
		}}
		f := recoveryPolicyFixture(t, stub)
		response := httptest.NewRecorder()
		request := recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, scenario.body, nil)
		if scenario.ifMatch != "" {
			request.Header.Set("If-Match", scenario.ifMatch)
		}
		f.raw.ServeHTTP(response, request)
		if response.Code != http.StatusOK || len(stub.writes) != 1 {
			t.Fatalf("%s: status=%d body=%s writes=%v", scenario.name, response.Code, response.Body.String(), stub.writes)
		}
		if stub.writes[0].ExpectedRevision == nil || *stub.writes[0].ExpectedRevision != 0 {
			t.Fatalf("%s: ExpectedRevision pointer = %v", scenario.name, stub.writes[0].ExpectedRevision)
		}
	}
}
