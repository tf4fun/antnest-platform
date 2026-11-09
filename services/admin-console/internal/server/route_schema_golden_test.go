package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
)

type goldenRegexp struct{ *regexp2.Regexp }

func (r goldenRegexp) MatchString(value string) bool {
	matched, err := r.Regexp.MatchString(value)
	return err == nil && matched
}

func adminSchemaCompiler(t *testing.T) *jsonschema.Compiler {
	t.Helper()
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	compiler.UseRegexpEngine(func(pattern string) (jsonschema.Regexp, error) {
		compiled, err := regexp2.Compile(pattern, regexp2.ECMAScript)
		if err != nil {
			return nil, err
		}
		compiled.MatchTimeout = 100 * time.Millisecond
		return goldenRegexp{compiled}, nil
	})
	root := "../../../../contracts"
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".schema.json") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			return err
		}
		relative := strings.TrimPrefix(path, root+"/")
		return compiler.AddResource("https://schemas.antnest.dev/"+relative, document)
	})
	if err != nil {
		t.Fatal(err)
	}
	return compiler
}

func compileAdminDef(t *testing.T, compiler *jsonschema.Compiler, name string) *jsonschema.Schema {
	t.Helper()
	schema, err := compiler.Compile(
		"https://schemas.antnest.dev/admin-console/admin-api.ids-v2.schema.json#/$defs/" + name,
	)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func validateAgainst(t *testing.T, schema *jsonschema.Schema, payload []byte) {
	t.Helper()
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if err := schema.Validate(document); err != nil {
		t.Fatalf("schema validation: %v\npayload: %s", err, payload)
	}
}

func readContractCatalog(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("../../../../contracts/admin-console/admin-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	return document
}

type cancelOnFlushRecorder struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (r *cancelOnFlushRecorder) Flush() {
	if strings.Contains(r.Body.String(), "\ndata:") && strings.Contains(r.Body.String(), "\n\n") {
		r.cancel()
	}
	r.ResponseRecorder.Flush()
}

type goldenRouteCase struct {
	method           string
	path             string
	body             string
	fixtures         []string
	skills           func(t *testing.T) (http.Handler, *skillStub)
	skillBody        string
	skillContentType string
	skillDigest      string
	skillHeaders     http.Header
	stream           bool
	binary           bool
}

func newGoldenHandler(t *testing.T, fixtures []string) (http.Handler, *backendStub) {
	t.Helper()
	backend := newBackendStub()
	for _, fixture := range fixtures {
		backend.enqueue(http.StatusOK, fixture)
	}
	return newTestHandler(t, backend), backend
}

func newGoldenSkillHandler(t *testing.T) (http.Handler, *skillStub) {
	t.Helper()
	stub := &skillStub{}
	return skillHandler(t, stub), stub
}

func requestGolden(t *testing.T, handler http.Handler, c goldenRouteCase) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	ctx := t.Context()
	var cancel context.CancelFunc
	if c.stream {
		streamContext, streamCancel := context.WithCancel(ctx)
		defer streamCancel()
		ctx, cancel = streamContext, streamCancel
	}
	request := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body)).WithContext(ctx)
	if c.body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "admin")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	request.Header.Set("Idempotency-Key", "test-idempotency-key-0001")
	request.Header.Set("X-Antnest-Expected-Principal", url.PathEscape(`["org-1","user-admin"]`))
	if c.stream {
		recorder := &cancelOnFlushRecorder{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
		handler.ServeHTTP(recorder, request)
		return recorder.ResponseRecorder, request
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response, request
}

func skillMultipartRequest(t *testing.T, method, path, idempotency string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if strings.Contains(path, "/versions") {
		if err := writer.WriteField("expected_version", "1"); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("artifact", "skill.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("PK\x03\x04artifact")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "admin")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	request.Header.Set("Idempotency-Key", idempotency)
	return request
}

func parsedRequestDocument(t *testing.T, route map[string]any, request *http.Request) []byte {
	t.Helper()
	document := map[string]any{}
	routePath := route["path"].(string)
	patternSegments := strings.Split(strings.Trim(routePath, "/"), "/")
	actualPath := strings.TrimPrefix(request.URL.Path, "/api/admin")
	actualSegments := strings.Split(strings.Trim(actualPath, "/"), "/")
	if len(patternSegments) != len(actualSegments) {
		t.Fatalf("path %s does not match route %s", request.URL.Path, routePath)
	}
	for index, segment := range patternSegments {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			name := strings.TrimSuffix(strings.TrimPrefix(segment, "{"), "}")
			if name == "version" || name == "revision" {
				number, err := strconv.Atoi(actualSegments[index])
				if err != nil {
					t.Fatal(err)
				}
				document[name] = number
			} else {
				document[name] = actualSegments[index]
			}
		}
	}
	for key, values := range request.URL.Query() {
		if len(values) != 1 {
			t.Fatalf("route query %s repeated in %s", key, request.URL)
		}
		value := values[0]
		switch key {
		case "limit", "after_sequence":
			number, err := strconv.Atoi(value)
			if err != nil {
				t.Fatal(err)
			}
			document[key] = number
		case "active":
			document[key] = value == "true"
		default:
			document[key] = value
		}
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func marshalFixture(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func goldenFixtures(t *testing.T) map[string]goldenRouteCase {
	t.Helper()
	agentPayload := reliabilityAgentPayload()
	agentPayload["agent_id"] = "agent-1"
	agentPayload["owner_user_id"] = "user-admin"
	agent := reliabilityAgentPayloadJSON(t, agentPayload)
	operation := reliabilityOperationPayloadJSON(t, reliabilityOperationPayload())
	template := templateUpstreamFixture("")
	memberItem := `{"user":{"id":"user-1","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"membership-1","organization_id":"org-1","user_id":"user-1","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}`
	groupItem := `{"id":"group-1","organization_id":"org-1","display_name":"Operators","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}`
	page := func(item string) string { return `{"items":[` + item + `],"next_cursor":null}` }
	emptyPage := `{"items":[],"next_cursor":null}`
	skillVersion := `{"skill_id":"` + sourceTarget + `","version":1,"name":"code-review","description":"Review code","artifact_digest":"` + sourceDigest + `","content_digest":"` + sourceDigest + `","artifact_size":100,"unpacked_size":200,"package_rules_version":1}`
	skillSummary := strings.Replace(skillVersion, `"version":1`, `"current_version":1`, 1)
	previewArchive, previewArtifactDigest, previewDigest := sourceArchive(t, "---\nname: code-review\ndescription: Review code\n---\nReview carefully.\n")
	return map[string]goldenRouteCase{
		"directory_members": {method: http.MethodGet, path: "/api/admin/directory/members", fixtures: []string{page(memberItem)}},
		"directory_groups":  {method: http.MethodGet, path: "/api/admin/directory/groups", fixtures: []string{page(groupItem)}},
		"directory":         {method: http.MethodGet, path: "/api/admin/directory", fixtures: []string{`{"users":[` + memberItem + `],"groups":[` + groupItem + `]}`}},
		"get_current_account": {method: http.MethodGet, path: "/api/admin/account", fixtures: []string{
			`{"account":{"user_id":"user-admin","organization_id":"org-1","organization_slug":"eng","organization_name":"Engineering","membership_id":"membership-1","email":"a@b.c","display_name":"Admin","source":"local","local_password_available":true}}`}},
		"list_agents": {method: http.MethodGet, path: "/api/admin/agents", fixtures: []string{emptyPage}},
		"get_agent":   {method: http.MethodGet, path: "/api/admin/agents/agent-1", fixtures: []string{agent}},
		"create_agent": {method: http.MethodPost, path: "/api/admin/agents",
			body:     `{"name":"agent-1","template_id":"template-1","template_revision":1,"owner_user_id":"user-admin"}`,
			fixtures: []string{`{"agent":` + agent + `,"operation":` + operation + `}`}},
		"enable_agent":  {method: http.MethodPost, path: "/api/admin/agents/agent-1/enable", body: `{}`, fixtures: []string{operation}},
		"disable_agent": {method: http.MethodPost, path: "/api/admin/agents/agent-1/disable", body: `{}`, fixtures: []string{operation}},
		"delete_agent":  {method: http.MethodPost, path: "/api/admin/agents/agent-1/delete", body: `{}`, fixtures: []string{operation}},
		"rebuild_agent": {method: http.MethodPost, path: "/api/admin/agents/agent-1/rebuild", body: `{"template_id":"template-1","template_revision":1}`, fixtures: []string{operation}},
		"cancel_lifecycle_operation": {method: http.MethodPost, path: "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			body:     `{"operation_request_id":"request-1"}`,
			fixtures: []string{operation}},
		"clear_lifecycle_quarantine": {method: http.MethodPost, path: "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			body:     `{"expected_aggregate_sequence":1}`,
			fixtures: []string{agent}},
		"get_operation":     {method: http.MethodGet, path: "/api/admin/operations/request-1", fixtures: []string{operation}},
		"list_agent_events": {method: http.MethodGet, path: "/api/admin/agents/agent-1/events", fixtures: []string{`{"events":[],"next_sequence":0}`}},
		"watch_agent_events": {method: http.MethodGet, path: "/api/admin/agents/agent-1/events/watch",
			fixtures: []string{"id: 42\nevent: agent_event\ndata: {\"event_id\":\"event-42\",\"global_sequence\":42,\"aggregate_sequence\":7,\"schema_version\":1,\"agent_id\":\"agent-1\",\"event_type\":\"agent.created\",\"occurred_at\":\"2026-11-01T00:00:00Z\"}\n\n"},
			stream:   true},
		"list_templates": {method: http.MethodGet, path: "/api/admin/templates", fixtures: []string{emptyPage}},
		"create_template": {method: http.MethodPost, path: "/api/admin/templates",
			body:     `{"name":"template-1","model_profile_id":"model-1"}`,
			fixtures: []string{template}},
		"get_template": {method: http.MethodGet, path: "/api/admin/templates/template-1", fixtures: []string{template}},
		"get_template_revision": {method: http.MethodGet, path: "/api/admin/templates/template-1/revisions/1",
			fixtures: []string{template}},
		"revise_template": {method: http.MethodPost, path: "/api/admin/templates/template-1/revisions",
			body:     `{"name":"template-1","model_profile_id":"model-1","max_model_requests":32}`,
			fixtures: []string{template}},
		"set_template_availability": {method: http.MethodPut, path: "/api/admin/templates/template-1/availability",
			body:     `{"enabled":false,"expected_enabled":true}`,
			fixtures: []string{`{"resource_id":"template-1","enabled":false,"updated_at":"2026-11-01T00:00:00Z"}`}},
		"get_template_defaults": {method: http.MethodGet, path: "/api/admin/template-defaults",
			fixtures: []string{`{"runtime_image_ref":"antnest/antnest-runtime@sha256:` + strings.Repeat("a", 64) + `"}`}},
		"list_model_profiles": {method: http.MethodGet, path: "/api/admin/model-profiles", fixtures: []string{emptyPage}},
		"create_model_profile": {method: http.MethodPost, path: "/api/admin/model-profiles",
			body:     `{"provider_connection_id":"connection-1","display_name":"Model","model":{"base_url":"https://models.example.com/v1","model":"model-1","context_window":8192,"max_output_tokens":1024,"supports_images":false}}`,
			fixtures: []string{`{"model_profile_id":"model-1","provider_connection_id":"connection-1","display_name":"Model","revision":1,"revision_id":"rev-1","enabled":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","model":{"base_url":"https://models.example.com/v1","model":"model-1","context_window":8192,"max_output_tokens":1024,"supports_images":false}}`}},
		"get_model_profile": {method: http.MethodGet, path: "/api/admin/model-profiles/model-1",
			fixtures: []string{`{"model_profile_id":"model-1","provider_connection_id":"connection-1","display_name":"Model","revision":1,"revision_id":"rev-1","enabled":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","model":{"base_url":"https://models.example.com/v1","model":"model-1","context_window":8192,"max_output_tokens":1024,"supports_images":false}}`}},
		"revise_model_profile": {method: http.MethodPost, path: "/api/admin/model-profiles/model-1/revisions",
			body:     `{"display_name":"Model","model":{"base_url":"https://models.example.com/v1","model":"model-1","context_window":8192,"max_output_tokens":1024,"supports_images":false},"expected_version":1}`,
			fixtures: []string{`{"model_profile_id":"model-1","provider_connection_id":"connection-1","display_name":"Model","revision":2,"revision_id":"rev-2","enabled":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","model":{"base_url":"https://models.example.com/v1","model":"model-1","context_window":8192,"max_output_tokens":1024,"supports_images":false}}`}},
		"set_model_availability": {method: http.MethodPut, path: "/api/admin/model-profiles/model-1/availability",
			body:     `{"enabled":false,"expected_enabled":true}`,
			fixtures: []string{`{"resource_id":"model-1","enabled":false,"updated_at":"2026-11-01T00:00:00Z"}`}},
		"get_model_profile_usage": {method: http.MethodGet, path: "/api/admin/model-profiles/model-1/usage",
			fixtures: []string{`{"templates":2,"agents":3}`}},
		"model_catalog": {method: http.MethodGet, path: "/api/admin/model-catalog",
			fixtures: []string{`{"revision":"rev-1","providers":[]}`}},
		"list_provider_connections": {method: http.MethodGet, path: "/api/admin/provider-connections", fixtures: []string{emptyPage}},
		"create_provider_connection": {method: http.MethodPost, path: "/api/admin/provider-connections",
			body:     `{"display_name":"DeepSeek","provider_key":"deepseek","base_url":"https://api.deepseek.com","credential":{"method":"api_key","api_key":"synthetic"},"models":[]}`,
			fixtures: []string{`{"connection_id":"connection-1","display_name":"DeepSeek","provider_key":"deepseek","base_url":"https://api.deepseek.com","credential_method":"api_key","credential_version":"v1","credential_revision":1,"enabled":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}`}},
		"get_provider_connection": {method: http.MethodGet, path: "/api/admin/provider-connections/connection-1",
			fixtures: []string{`{"connection_id":"connection-1","display_name":"DeepSeek","provider_key":"deepseek","base_url":"https://api.deepseek.com","credential_method":"api_key","credential_version":"v1","credential_revision":1,"enabled":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}`}},
		"rotate_provider_credential": {method: http.MethodPost, path: "/api/admin/provider-connections/connection-1/credentials",
			body:     `{"expected_version":"1","credential":{"method":"api_key","api_key":"synthetic"}}`,
			fixtures: []string{`{"connection_id":"connection-1","display_name":"DeepSeek","provider_key":"deepseek","base_url":"https://api.deepseek.com","credential_method":"api_key","credential_version":"v2","credential_revision":2,"enabled":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}`}},
		"set_provider_availability": {method: http.MethodPut, path: "/api/admin/provider-connections/connection-1/availability",
			body:     `{"enabled":false,"expected_enabled":true}`,
			fixtures: []string{`{"resource_id":"connection-1","enabled":false,"updated_at":"2026-11-01T00:00:00Z"}`}},
		"discover_provider_models": {method: http.MethodGet, path: "/api/admin/provider-connections/connection-1/models/discovery",
			fixtures: []string{`{"models":[]}`}},
		"discover_draft_models": {method: http.MethodPost, path: "/api/admin/provider-models/discovery",
			body:     `{"provider_key":"deepseek","base_url":"https://api.deepseek.com","credential":{"method":"api_key","api_key":"synthetic"}}`,
			fixtures: []string{`{"models":[]}`}},
		"list_skills": {method: http.MethodGet, path: "/api/admin/skills", skills: newGoldenSkillHandler, skillBody: page(skillSummary)},
		"publish_skill": {method: http.MethodPost, path: "/api/admin/skills",
			skills: newGoldenSkillHandler, skillBody: `{"skill_id":"` + sourceTarget + `","version":1,"name":"code-review","description":"Review code","artifact_digest":"` + sourceDigest + `","content_digest":"` + sourceDigest + `","artifact_size":100,"unpacked_size":200,"package_rules_version":1}`},
		"publish_skill_version": {method: http.MethodPost, path: "/api/admin/skills/" + sourceTarget + "/versions",
			skills: newGoldenSkillHandler, skillBody: `{"skill_id":"` + sourceTarget + `","version":1,"name":"code-review","description":"Review code","artifact_digest":"` + sourceDigest + `","content_digest":"` + sourceDigest + `","artifact_size":100,"unpacked_size":200,"package_rules_version":1}`},
		"list_skill_versions": {method: http.MethodGet, path: "/api/admin/skills/" + sourceTarget + "/versions",
			skills: newGoldenSkillHandler, skillBody: page(skillVersion)},
		"download_skill_version": {method: http.MethodGet, path: "/api/admin/skills/" + sourceTarget + "/versions/1/artifact",
			skills: newGoldenSkillHandler, skillBody: previewArchive, skillDigest: previewArtifactDigest, skillContentType: "application/zip", binary: true},
		"search_skill_sources": {method: http.MethodPost, path: "/api/admin/skill-sources/search",
			body:      `{"query":"review","limit":50}`,
			skills:    newGoldenSkillHandler,
			skillBody: `{"items":[{"skill_ref":` + sourceRefJSON + `,"name":"code-review","description":"Review code","content_digest":"` + sourceDigest + `","owner_id":"private","instructions":"hidden"}],"next_cursor":null}`},
		"preview_skill_source": {method: http.MethodPost, path: "/api/admin/skill-sources/preview",
			body:      sourceSelection(previewDigest),
			skills:    newGoldenSkillHandler,
			skillBody: previewArchive, skillContentType: "application/zip", skillDigest: previewArtifactDigest,
			skillHeaders: http.Header{"X-Antnest-Content-Digest": []string{previewDigest}}},
		"promote_skill_source": {method: http.MethodPost, path: "/api/admin/skill-sources/promote",
			body:   strings.TrimSuffix(sourceSelection(sourceDigest), "}") + `,"skill_id":"` + sourceTarget + `","expected_version":"2"}`,
			skills: newGoldenSkillHandler, skillBody: `{"skill_id":"` + sourceTarget + `","version":3,"name":"code-review","description":"Review code","artifact_digest":"` + sourceDigest + `","content_digest":"` + sourceDigest + `","artifact_size":100,"unpacked_size":200,"package_rules_version":1,"source_owner":"hidden"}`},
		"get_agent_skill_preparation": {method: http.MethodGet, path: "/api/admin/agent-skill-preparations/request-1",
			fixtures: []string{`{"request_id":"request-1","agent_id":"agent-1","kind":"prepare","state":"accepted","progress":{"verified_packages":0,"total_packages":0,"total_bytes":0,"verified_bytes":0},"updated_at":"2026-11-01T00:00:00Z"}`}},
		"get_agent_skill_preparation_by_key": {method: http.MethodGet, path: "/api/admin/agent-skill-preparations/by-idempotency-key",
			fixtures: []string{`{"request_id":"request-1","agent_id":"agent-1","kind":"prepare","state":"accepted","progress":{"verified_packages":0,"total_packages":0,"total_bytes":0,"verified_bytes":0},"updated_at":"2026-11-01T00:00:00Z"}`}},
		"get_agent_network_policy": {method: http.MethodGet, path: "/api/admin/agents/agent-1/network-policy",
			fixtures: []string{networkViewFixture()}},
		"set_agent_network_policy": {method: http.MethodPut, path: "/api/admin/agents/agent-1/network-policy",
			body:     `{"action":"allow_all","expected_version":"7"}`,
			fixtures: []string{networkAssignment}},
		"list_execution_audits": {method: http.MethodGet, path: "/api/admin/execution-audits",
			fixtures: []string{`{"items":[` + auditSummaryFixture + `],"next_cursor":null}`}},
		"get_execution_audit": {method: http.MethodGet, path: "/api/admin/execution-audits/run-1",
			fixtures: []string{auditDetailFixture()}},
		"list_execution_events": {method: http.MethodGet, path: "/api/admin/execution-audits/run-1/events?stream=execution",
			fixtures: []string{`{"stream":"execution","items":[],"next_cursor":null}`}},
		"get_execution_synchronization": {method: http.MethodGet, path: "/api/admin/execution-synchronization",
			fixtures: []string{`{"organization_id":"org-1","synchronization":null}`}},
		"get_model_call_policy": {method: http.MethodGet, path: "/api/admin/model-call-policy",
			fixtures: []string{modelCallPolicyUpstreamPolicy("org-1", 1)}},
		"set_model_call_policy": {method: http.MethodPut, path: "/api/admin/model-call-policy",
			body:     modelCallPolicyBody,
			fixtures: []string{modelCallPolicyUpstreamPolicy("org-1", 1)}},
		"overview": {method: http.MethodGet, path: "/api/admin/overview",
			fixtures: []string{`{"users":[],"groups":[]}`, emptyPage, emptyPage, emptyPage}},
		"list_oidc_providers": {method: http.MethodGet, path: "/api/admin/provisioning/oidc-providers",
			fixtures: []string{`{"providers":[]}`}},
		"upsert_oidc_provider": {method: http.MethodPost, path: "/api/admin/provisioning/oidc-providers",
			body:     `{"name":"provider","issuer":"https://issuer.example.com","client_id":"client","enabled":true}`,
			fixtures: []string{`{"provider":{"name":"provider","display_name":"Provider","issuer":"https://issuer.example.com","client_id":"client","enabled":true,"scopes":[],"revision":1,"authorization_endpoint":"https://issuer.example.com/auth","token_endpoint":"https://issuer.example.com/token","jwks_uri":"https://issuer.example.com/jwks","token_endpoint_auth_method":"client_secret_basic","id_token_signing_algs":["RS256"],"link_policy":"verified_email_in_domains","link_domains":["example.com"],"authoritative":false,"link_policy_review_required":false,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}`}},
		"set_oidc_provider_enabled": {method: http.MethodPost, path: "/api/admin/provisioning/oidc-providers/provider/enabled",
			body:     `{"enabled":true}`,
			fixtures: []string{`{"provider":{"name":"provider","display_name":"Provider","issuer":"https://issuer.example.com","client_id":"client","enabled":true,"scopes":[],"revision":1,"authorization_endpoint":"https://issuer.example.com/auth","token_endpoint":"https://issuer.example.com/token","jwks_uri":"https://issuer.example.com/jwks","token_endpoint_auth_method":"client_secret_basic","id_token_signing_algs":["RS256"],"link_policy":"verified_email_in_domains","link_domains":["example.com"],"authoritative":false,"link_policy_review_required":false,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}`}},
		"issue_scim_token": {method: http.MethodPost, path: "/api/admin/provisioning/scim-tokens",
			body:     `{"name":"token","scopes":["scim:write"]}`,
			fixtures: []string{scimLifecycleReply(t, scimLifecycleToken(), true)}},
		"list_scim_tokens": {method: http.MethodGet, path: "/api/admin/provisioning/scim-tokens",
			fixtures: []string{`{"tokens":[]}`}},
		"revoke_scim_token": {method: http.MethodPost, path: "/api/admin/provisioning/scim-tokens/token-1/revoke",
			body:     `{}`,
			fixtures: []string{`{"status":"updated"}`}},
		"create_local_user": {method: http.MethodPost, path: "/api/admin/directory/users",
			body:     `{"email":"new@example.com","display_name":"New","password":"correct horse battery staple","role":"member"}`,
			fixtures: []string{`{"user":{"id":"user-2","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"membership-2","user_id":"user-2","email":"new@example.com","display_name":"New","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}`}},
		"update_membership": {method: http.MethodPost, path: "/api/admin/directory/memberships/membership-1",
			body:     `{"email":"a@b.c","display_name":"Renamed","role":"member","active":true}`,
			fixtures: []string{`{"membership":{"id":"membership-1","organization_id":"org-1","user_id":"user-1","email":"a@b.c","display_name":"Renamed","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}`}},
		"set_user_active": {method: http.MethodPost, path: "/api/admin/directory/users/user-1/active",
			body:     `{"active":false}`,
			fixtures: []string{`{"status":"updated"}`}},
		"list_organization_sessions": {method: http.MethodGet, path: "/api/admin/directory/users/user-1/sessions?limit=50",
			fixtures: []string{emptyPage}},
		"revoke_organization_sessions": {method: http.MethodPost, path: "/api/admin/directory/users/user-1/sessions/revoke",
			body:     `{}`,
			fixtures: []string{`{"revoked_count":0,"current_revoked":false}`}},
		"list_external_identity_providers": {method: http.MethodGet, path: "/api/admin/directory/identity-providers?limit=50",
			fixtures: []string{`{"providers":[` + marshalFixture(t, externalProviderRow()) + `],"next_cursor":null}`}},
		"list_external_identities": {method: http.MethodGet, path: "/api/admin/directory/memberships/membership-1/external-identities?limit=50",
			fixtures: []string{`{"bindings":[` + marshalFixture(t, externalBindingRow()) + `],"next_cursor":null}`}},
		"bind_external_identity": {method: http.MethodPost, path: "/api/admin/directory/memberships/membership-1/external-identities",
			body:     `{"provider_id":"provider-1","subject":"  <opaque> e\u0301 \ud83d\ude00  ","restore_revoked":false}`,
			fixtures: []string{`{"binding":` + marshalFixture(t, externalBindingRow()) + `}`}},
		"unbind_external_identity": {method: http.MethodDelete, path: "/api/admin/directory/memberships/membership-1/external-identities/binding-1",
			body:     `{"allow_lockout":false}`,
			fixtures: []string{`{"revoked_count":0,"current_revoked":false}`}},
	}
}

func TestAdminRouteResponsesConformToPublishedSchema(t *testing.T) {
	routes := readContractCatalog(t)["routes"].(map[string]any)
	cases := goldenFixtures(t)
	if len(cases) != 71 {
		t.Fatalf("golden registry must cover all 71 routes: %d", len(cases))
	}
	for name := range routes {
		if _, ok := cases[name]; !ok {
			t.Fatalf("route %s missing golden case", name)
		}
	}
	compiler := adminSchemaCompiler(t)
	for name, raw := range routes {
		route := raw.(map[string]any)
		t.Run(name, func(t *testing.T) {
			golden := cases[name]
			if route["response_schema"] != "admin-api.ids-v2.schema.json#/$defs/"+name+"_response" {
				t.Fatalf("route %s response_schema = %v", name, route["response_schema"])
			}
			if route["request_schema"] != "admin-api.ids-v2.schema.json#/$defs/"+name+"_request" {
				t.Fatalf("route %s request_schema = %v", name, route["request_schema"])
			}
			var handler http.Handler
			var request *http.Request
			var response *httptest.ResponseRecorder
			if golden.skills != nil {
				skillHTTP, stub := golden.skills(t)
				stub.body = golden.skillBody
				stub.digest = golden.skillDigest
				stub.headers = golden.skillHeaders
				if name == "publish_skill" || name == "publish_skill_version" || name == "promote_skill_source" {
					stub.status = http.StatusCreated
				}
				if golden.skillContentType != "" {
					stub.contentType = golden.skillContentType
				}
				handler = skillHTTP
				if route["request_body"].(map[string]any)["kind"] == "multipart" {
					request = skillMultipartRequest(t, golden.method, golden.path, "test-idempotency-key-0001")
					multipartBody, err := io.ReadAll(request.Body)
					if err != nil {
						t.Fatal(err)
					}
					request.Body = io.NopCloser(bytes.NewReader(multipartBody))
					response = httptest.NewRecorder()
					handler.ServeHTTP(response, request)
					request.Body = io.NopCloser(bytes.NewReader(multipartBody))
					if err := request.ParseMultipartForm(1 << 20); err != nil {
						t.Fatal(err)
					}
				} else {
					response, request = requestGolden(t, handler, golden)
				}
			} else {
				var backend *backendStub
				handler, backend = newGoldenHandler(t, golden.fixtures)
				if name == "overview" {
					backend.responses = nil
					backend.enqueueFor("/rpc/identity/list-directory", http.StatusOK, `{"users":[],"groups":[]}`)
					for _, path := range []string{"/internal/model-profiles", "/internal/agent-templates", "/internal/agents"} {
						backend.enqueueFor(path, http.StatusOK, `{"items":[],"next_cursor":null}`)
					}
				}
				response, request = requestGolden(t, handler, golden)
			}
			if response.Code < 200 || response.Code >= 300 {
				t.Fatalf("route %s: status=%d body=%s", name, response.Code, response.Body.String())
			}
			requestBody, _ := route["request_body"].(map[string]any)
			kind, _ := requestBody["kind"].(string)
			switch kind {
			case "json":
				body := golden.body
				if body == "" {
					body = `{}`
				}
				validateAgainst(t, compileAdminDef(t, compiler, name+"_request"), []byte(body))
			case "none":
				validateAgainst(t, compileAdminDef(t, compiler, name+"_request"),
					parsedRequestDocument(t, route, request))
			case "multipart":
				form := map[string]any{"artifact": "skill.zip"}
				if name == "publish_skill_version" {
					form["expected_version"] = request.FormValue("expected_version")
				}
				validateAgainst(t, compileAdminDef(t, compiler, name+"_request"),
					[]byte(marshalFixture(t, form)))
			}
			if golden.binary {
				if content := response.Header().Get("Content-Type"); !strings.Contains(content, "zip") {
					t.Fatalf("route %s content-type = %q", name, content)
				}
				return
			}
			if golden.stream {
				scanner := bufio.NewScanner(strings.NewReader(response.Body.String()))
				var event, data string
				for scanner.Scan() {
					line := scanner.Text()
					if strings.HasPrefix(line, "event:") {
						event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
					}
					if strings.HasPrefix(line, "data:") {
						data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
						break
					}
				}
				if data == "" || event != "agent_event" {
					t.Fatalf("route %s stream did not emit a canonical event: %q", name, response.Body.String())
				}
				validateAgainst(t, compileAdminDef(t, compiler, name+"_response"), []byte(data))
				return
			}
			validateAgainst(t, compileAdminDef(t, compiler, name+"_response"), response.Body.Bytes())
		})
	}
}

func TestAdminRouteResponseSchemaRejectsPrivateFields(t *testing.T) {
	compiler := adminSchemaCompiler(t)
	schema := compileAdminDef(t, compiler, "directory_members_response")
	document, err := jsonschema.UnmarshalJSON(strings.NewReader(
		`{"items":[{"user":{"id":"u","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","credential_ref":"x"},"membership":{"id":"m","user_id":"u","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","organization_id":"org-1"}}],"next_cursor":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(document); err == nil {
		t.Fatal("directory page must reject private fields")
	}
}
