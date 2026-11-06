package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

const goldenIdentityExamples = "../../../../contracts/identity/examples"

func readGoldenDocument(t *testing.T, name string) (raw []byte, document map[string]any) {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(goldenIdentityExamples, name))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	if err := json.Unmarshal(contents, &document); err != nil {
		t.Fatalf("parse golden %s: %v", name, err)
	}
	return contents, document
}

func withFutureFields(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed)+1)
		out["x_future_field"] = float64(1)
		for key, item := range typed {
			out[key] = withFutureFields(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = withFutureFields(item)
		}
		return out
	default:
		return typed
	}
}

func goldenClient(t *testing.T, body any) *Client {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode response: %v", err)
	}
	client, err := NewClient("http://identity.internal", &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, string(encoded)), nil
		}),
	})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(client.Close)
	return client
}

func TestConsumerGoldenListLoginMethods(t *testing.T) {
	_, document := readGoldenDocument(t, "list-login-methods.member.json")
	baseline, err := goldenClient(t, document).ListLoginMethods(context.Background(), "engineering")
	if err != nil {
		t.Fatalf("baseline decode: %v", err)
	}
	if len(baseline) != 1 || baseline[0] != (LoginMethod{Name: "local", DisplayName: "Local"}) {
		t.Fatalf("methods=%+v", baseline)
	}
	extended, err := goldenClient(t, withFutureFields(document)).ListLoginMethods(context.Background(), "engineering")
	if err != nil {
		t.Fatalf("extended decode: %v", err)
	}
	if !reflect.DeepEqual(extended, baseline) {
		t.Fatalf("extended=%+v baseline=%+v", extended, baseline)
	}
}

func TestConsumerGoldenLocalLogin(t *testing.T) {
	_, document := readGoldenDocument(t, "local-login.member.json")
	input := LoginInput{
		RequestID:        "request-1",
		OrganizationSlug: "engineering",
		Email:            "owner@example.test",
		Password:         "synthetic-password",
	}
	baseline, err := goldenClient(t, document).Login(context.Background(), input)
	if err != nil {
		t.Fatalf("baseline decode: %v", err)
	}
	if baseline.AccessToken != "ant_api_contract" || baseline.TokenID == "" ||
		baseline.ActivityIntervalMS != 30000 ||
		baseline.Principal.UserID != "user-1" ||
		baseline.Principal.OrganizationID != "org-1" ||
		baseline.Principal.OrganizationSlug != "engineering" ||
		baseline.Principal.OrganizationName != "Engineering" ||
		baseline.Principal.MembershipID != "membership-1" ||
		baseline.Principal.SystemRole != "user" ||
		baseline.Principal.OrganizationRole != "member" ||
		!baseline.Principal.Active {
		t.Fatalf("login=%+v", baseline)
	}
	extended, err := goldenClient(t, withFutureFields(document)).Login(context.Background(), input)
	if err != nil {
		t.Fatalf("extended decode: %v", err)
	}
	if !reflect.DeepEqual(extended, baseline) {
		t.Fatalf("extended=%+v baseline=%+v", extended, baseline)
	}
}

func comparablePrincipal(principal Principal) Principal {
	principal.ResolveStartedAt = time.Time{}
	principal.ResolveCompletedAt = time.Time{}
	principal.ResolveValidUntil = time.Time{}
	principal.ResolveCacheHit = false
	return principal
}

func TestConsumerGoldenResolveAccessToken(t *testing.T) {
	_, document := readGoldenDocument(t, "resolve-access-token.member.json")
	ctx := WithResolution(context.Background(), "console", "")
	baseline, err := goldenClient(t, document).Resolve(ctx, "ant_api_contract")
	if err != nil {
		t.Fatalf("baseline decode: %v", err)
	}
	if baseline.UserID != "user-1" ||
		baseline.OrganizationID != "org-1" ||
		baseline.OrganizationSlug != "engineering" ||
		baseline.OrganizationName != "Engineering" ||
		baseline.MembershipID != "membership-1" ||
		baseline.SystemRole != "user" ||
		baseline.OrganizationRole != "member" ||
		!baseline.Active {
		t.Fatalf("principal=%+v", baseline)
	}
	extended, err := goldenClient(t, withFutureFields(document)).Resolve(ctx, "ant_api_contract")
	if err != nil {
		t.Fatalf("extended decode: %v", err)
	}
	if comparablePrincipal(extended) != comparablePrincipal(baseline) {
		t.Fatalf("extended=%+v baseline=%+v", comparablePrincipal(extended), comparablePrincipal(baseline))
	}
}

func TestConsumerGoldenRejectsInvalidKnownFields(t *testing.T) {
	_, methodsDocument := readGoldenDocument(t, "list-login-methods.member.json")
	methodsDocument["methods"].([]any)[0].(map[string]any)["name"] = float64(1)
	if _, err := goldenClient(t, withFutureFields(methodsDocument)).ListLoginMethods(context.Background(), "engineering"); err == nil {
		t.Fatalf("method name integer accepted")
	}

	_, loginDocument := readGoldenDocument(t, "local-login.member.json")
	_, resolveDocument := readGoldenDocument(t, "resolve-access-token.member.json")
	ctx := WithResolution(context.Background(), "console", "")
	for name, mutate := range map[string]func(map[string]any){
		"active-wrong-type": func(document map[string]any) {
			document["principal"].(map[string]any)["active"] = "yes"
		},
		"principal-null": func(document map[string]any) {
			document["principal"] = nil
		},
		"principal-missing": func(document map[string]any) {
			delete(document, "principal")
		},
	} {
		login := cloneDocument(t, loginDocument)
		mutate(login)
		if _, err := goldenClient(t, withFutureFields(login)).Login(context.Background(), LoginInput{}); err == nil {
			t.Fatalf("login %s accepted", name)
		}
		resolve := cloneDocument(t, resolveDocument)
		mutate(resolve)
		if _, err := goldenClient(t, withFutureFields(resolve)).Resolve(ctx, "ant_api_contract"); err == nil {
			t.Fatalf("resolve %s accepted", name)
		}
	}
}

func cloneDocument(t *testing.T, document map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("clone encode: %v", err)
	}
	var clone map[string]any
	if err := json.Unmarshal(encoded, &clone); err != nil {
		t.Fatalf("clone decode: %v", err)
	}
	return clone
}

func TestExternalIdentitiesResponseToleratesExtensions(t *testing.T) {
	ctx := WithPrincipal(t.Context(), browserCaller(t))
	input := ExternalIdentityListInput{Limit: 1, AfterID: "binding-1", NoticeAfterID: "notice-3"}
	baseline, err := externalReplyClient(t, externalJSON(t, externalPageFixture())).ListExternalIdentities(ctx, input)
	if err != nil {
		t.Fatalf("baseline decode: %v", err)
	}
	extended, err := externalReplyClient(t, externalJSON(t, withFutureFields(externalPageFixture()))).ListExternalIdentities(ctx, input)
	if err != nil {
		t.Fatalf("extended decode: %v", err)
	}
	if !reflect.DeepEqual(extended, baseline) {
		t.Fatalf("extended=%+v baseline=%+v", extended, baseline)
	}
	malformed := externalPageFixture()
	malformed["items"].([]any)[0].(map[string]any)["provider_enabled"] = "broken"
	if _, err := externalReplyClient(t, externalJSON(t, withFutureFields(malformed))).ListExternalIdentities(ctx, input); err == nil {
		t.Fatalf("provider_enabled string accepted")
	}
}

func TestPasswordFailureResponseProjection(t *testing.T) {
	header := http.Header{"Retry-After": []string{"1"}}
	body := map[string]any{
		"code":       "credential_busy",
		"message":    "Password verification is busy",
		"retryable":  true,
		"category":   "unavailable",
		"request_id": "golden-1",
		"details":    map[string]any{},
	}
	encoded, err := json.Marshal(withFutureFields(body))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	failure, ok := PasswordAdmissionFailure(decodePasswordFailure(http.StatusServiceUnavailable, header, encoded))
	if !ok || failure.Code != "credential_busy" || failure.RetryAfter != "1" {
		t.Fatalf("failure=%+v ok=%v", failure, ok)
	}
	malformed := cloneDocument(t, body)
	malformed["retryable"] = "yes"
	encoded, err = json.Marshal(withFutureFields(malformed))
	if err != nil {
		t.Fatalf("encode malformed: %v", err)
	}
	if err := decodePasswordFailure(http.StatusServiceUnavailable, header, encoded); err == nil {
		t.Fatalf("malformed retryable accepted")
	}
}

func TestResponseObjectProjection(t *testing.T) {
	type record struct {
		Name string `json:"name"`
	}
	type nested struct {
		Records []record `json:"records"`
	}
	type target struct {
		Code   string `json:"code"`
		Count  int    `json:"count"`
		Nested nested `json:"nested"`
	}

	var projected target
	if err := decodeResponseObject([]byte(`{
		"code":"ok","count":2,
		"nested":{"records":[{"name":"a","extra":1}],"x":true},
		"x_future_field":{"deep":[1]}
	}`), &projected); err != nil {
		t.Fatalf("projection: %v", err)
	}
	if projected.Code != "ok" || projected.Count != 2 ||
		len(projected.Nested.Records) != 1 || projected.Nested.Records[0].Name != "a" {
		t.Fatalf("projected=%+v", projected)
	}

	var aliased target
	if err := decodeResponseObject([]byte(`{"code":"exact","CODE":"alias","count":1}`), &aliased); err != nil {
		t.Fatalf("alias decode: %v", err)
	}
	if aliased.Code != "exact" || aliased.Count != 1 {
		t.Fatalf("aliased=%+v", aliased)
	}

	var invalid target
	if err := decodeResponseObject([]byte(`{"code":1,"count":1,"nested":{"records":[]}}`), &invalid); err == nil {
		t.Fatalf("invalid known field type accepted")
	}

	for _, body := range []string{
		`{"code":"a","code":"b"}`,
		`{"code":"a"} {"b":1}`,
		`{`,
		"{\"code\":\"\x80\"}",
	} {
		var rejected target
		if err := decodeResponseObject([]byte(body), &rejected); err == nil {
			t.Fatalf("%q accepted", body)
		}
	}
}
