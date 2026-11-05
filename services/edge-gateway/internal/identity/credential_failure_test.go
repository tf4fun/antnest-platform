package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

const credentialBusyBody = `{"code":"credential_busy","message":"Password verification is busy","retryable":true}`
const credentialRateBody = `{"code":"credential_rate_limited","message":"Too many password attempts","retryable":true}`

func callPasswordRPC(t *testing.T, route string, response *http.Response) error {
	t.Helper()
	calls := 0
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.URL.Path != "/rpc/identity/"+route || request.Method != http.MethodPost {
			t.Error("wrong password RPC")
		}
		return response, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	if route == "local-login" {
		result, failure := client.Login(t.Context(), LoginInput{RequestID: "request", OrganizationSlug: "org", Email: "account@example.test", Password: "private-password-canary"})
		if result != (LoginResult{}) {
			t.Fatal("failed password request returned credentials")
		}
		err = failure
	} else {
		result, failure := client.ChangePassword(WithPrincipal(t.Context(), browserCaller(t)), PasswordInput{RequestID: "request", CurrentPassword: "private-password-canary", NewPassword: "replacement-password"})
		if result != (LoginResult{}) {
			t.Fatal("failed password change returned credentials")
		}
		err = failure
	}
	if calls != 1 {
		t.Fatalf("password request was not made exactly once: %d", calls)
	}
	if err == nil || strings.Contains(err.Error(), "private-password-canary") {
		t.Fatal("missing or private password failure")
	}
	return err
}

func TestPasswordAdmissionClientAcceptsOnlyValidatedFailures(t *testing.T) {
	for _, route := range []string{"local-login", "change-local-password"} {
		for _, row := range []struct {
			status                     int
			body, retry, code, message string
		}{{503, credentialBusyBody, "1", "credential_busy", "Password verification is busy"}, {429, credentialRateBody, "1", "credential_rate_limited", "Too many password attempts"}, {429, credentialRateBody, "2", "credential_rate_limited", "Too many password attempts"}, {429, credentialRateBody, "900", "credential_rate_limited", "Too many password attempts"}} {
			t.Run(route+"/"+row.code+"/"+row.retry, func(t *testing.T) {
				response := jsonResponse(row.status, row.body)
				response.Header.Set("Retry-After", row.retry)
				err := callPasswordRPC(t, route, response)
				failure, ok := PasswordAdmissionFailure(fmt.Errorf("operation: %w", err))
				if !ok || failure != (PasswordFailure{StatusCode: row.status, Code: row.code, Message: row.message, RetryAfter: row.retry}) {
					t.Fatal("valid credential failure lost its exact public projection")
				}
			})
		}
	}
}

func TestPasswordAdmissionClientRejectsMalformedMetadata(t *testing.T) {
	rows := []struct {
		name    string
		status  int
		body    string
		headers []string
	}{
		{"wrong-status", 401, credentialBusyBody, []string{"1"}},
		{"rate-status-busy-code", 429, credentialBusyBody, []string{"1"}},
		{"busy-status-rate-code", 503, credentialRateBody, []string{"1"}},
		{"busy-status-legacy-code", 503, `{"code":"unauthenticated","message":"denied","retryable":true}`, []string{"1"}},
		{"missing-code", 503, `{"message":"Password verification is busy","retryable":true}`, []string{"1"}},
		{"missing-message", 503, `{"code":"credential_busy","retryable":true}`, []string{"1"}},
		{"missing-retryable", 503, `{"code":"credential_busy","message":"Password verification is busy"}`, []string{"1"}},
		{"null-retryable", 503, strings.Replace(credentialBusyBody, "true", "null", 1), []string{"1"}},
		{"false-retryable", 503, strings.Replace(credentialBusyBody, "true", "false", 1), []string{"1"}},
		{"string-retryable", 503, strings.Replace(credentialBusyBody, "true", `"true"`, 1), []string{"1"}},
		{"null-code", 503, strings.Replace(credentialBusyBody, `"credential_busy"`, "null", 1), []string{"1"}},
		{"null-message", 503, strings.Replace(credentialBusyBody, `"Password verification is busy"`, "null", 1), []string{"1"}},
		{"private-message", 503, strings.Replace(credentialBusyBody, "Password verification is busy", "private-password-canary", 1), []string{"1"}},
		{"private-code", 503, strings.Replace(credentialBusyBody, "credential_busy", "private-password-canary", 1), []string{"1"}},
		{"unknown-member", 503, strings.TrimSuffix(credentialBusyBody, "}") + `,"private-password-canary":true}`, []string{"1"}},
		{"duplicate-code", 401, strings.TrimSuffix(credentialBusyBody, "}") + `,"code":"unauthenticated"}`, []string{"1"}},
		{"escaped-duplicate", 503, strings.TrimSuffix(credentialBusyBody, "}") + `,"\u0063ode":"credential_busy"}`, []string{"1"}},
		{"case-alias", 503, strings.Replace(credentialBusyBody, `"code"`, `"Code"`, 1), []string{"1"}},
		{"trailing-object", 503, credentialBusyBody + "{}", []string{"1"}},
		{"array", 503, "[" + credentialBusyBody + "]", []string{"1"}},
		{"null", 503, "null", []string{"1"}},
		{"malformed-json", 503, strings.TrimSuffix(credentialBusyBody, "}"), []string{"1"}},
		{"bom", 503, "\ufeff" + credentialBusyBody, []string{"1"}},
		{"invalid-utf8", 503, strings.Replace(credentialBusyBody, "verification", "\xff", 1), []string{"1"}},
		{"oversized", 503, strings.Repeat(" ", maximumResponseBytes) + credentialBusyBody, []string{"1"}},
		{"missing-header", 429, credentialRateBody, nil},
		{"duplicate-header", 429, credentialRateBody, []string{"1", "1"}},
		{"busy-delay", 503, credentialBusyBody, []string{"2"}},
	}
	for _, value := range []string{"", "0", "901", "01", "+1", "-1", "1.0", "1, 1", " 1", "1 ", "1e0", "999999999999999999999", "Wed, 21 Oct 2015 07:28:00 GMT"} {
		rows = append(rows, struct {
			name    string
			status  int
			body    string
			headers []string
		}{"header-" + value, 429, credentialRateBody, []string{value}})
	}
	for _, route := range []string{"local-login", "change-local-password"} {
		for _, row := range rows {
			t.Run(route+"/"+row.name, func(t *testing.T) {
				response := jsonResponse(row.status, row.body)
				for _, value := range row.headers {
					response.Header.Add("Retry-After", value)
				}
				err := callPasswordRPC(t, route, response)
				if _, ok := PasswordAdmissionFailure(err); ok {
					t.Fatal("malformed failure acquired trusted retry metadata")
				}
				var remote *RemoteError
				if errors.As(err, &remote) {
					t.Fatal("malformed password failure fell back into an unvalidated remote classification")
				}
			})
		}
	}
}

func TestPasswordAdmissionClientPreservesLegacyErrorsAndScope(t *testing.T) {
	for _, route := range []string{"local-login", "change-local-password"} {
		for _, code := range []string{"invalid_current_password", "invalid_argument", "unauthenticated", "inactive_principal", "forbidden", "caller_context_invalid", "caller_context_required"} {
			t.Run(route+"/"+code, func(t *testing.T) {
				err := callPasswordRPC(t, route, jsonResponse(400, `{"code":"`+code+`","message":"private-password-canary","retryable":false}`))
				if !IsCode(err, code) {
					t.Fatal("legacy error classification changed")
				}
				if _, ok := PasswordAdmissionFailure(err); ok {
					t.Fatal("legacy failure gained a retry hint")
				}
			})
		}
	}
	for _, err := range []error{nil, &RemoteError{StatusCode: 503, Code: "credential_busy", Message: "Password verification is busy", Retryable: true}} {
		if _, ok := PasswordAdmissionFailure(err); ok {
			t.Fatal("unvalidated RemoteError acquired trusted retry metadata")
		}
	}
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		response := jsonResponse(503, credentialBusyBody)
		response.Header.Set("Retry-After", "1")
		return response, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.CurrentAccount(WithPrincipal(context.Background(), browserCaller(t)))
	if _, ok := PasswordAdmissionFailure(err); ok {
		t.Fatal("non-password RPC acquired password retry semantics")
	}
}

type passwordFailureReader struct{}

func (passwordFailureReader) Read([]byte) (int, error) {
	return 0, errors.New("private-password-canary")
}

func (passwordFailureReader) Close() error { return nil }

func TestPasswordAdmissionClientRejectsUnreadableAndDuplicateHeaders(t *testing.T) {
	for _, route := range []string{"local-login", "change-local-password"} {
		t.Run(route+"/read-error", func(t *testing.T) {
			response := jsonResponse(503, credentialBusyBody)
			response.Header.Set("Retry-After", "1")
			response.Body = passwordFailureReader{}
			err := callPasswordRPC(t, route, response)
			if _, ok := PasswordAdmissionFailure(err); ok {
				t.Fatal("unreadable response acquired trusted retry metadata")
			}
		})
		t.Run(route+"/header-case-alias", func(t *testing.T) {
			response := jsonResponse(503, credentialBusyBody)
			response.Header["Retry-After"] = []string{"1"}
			response.Header["retry-after"] = []string{"1"}
			err := callPasswordRPC(t, route, response)
			if _, ok := PasswordAdmissionFailure(err); ok {
				t.Fatal("duplicate header alias acquired trusted retry metadata")
			}
		})
	}
}

func TestPasswordAdmissionClientRejectsMixedSuccess(t *testing.T) {
	for _, route := range []string{"local-login", "change-local-password"} {
		for _, failure := range []string{credentialBusyBody, credentialRateBody} {
			for _, key := range []string{"code", "Code"} {
				t.Run(route+"/"+failure+"/"+key, func(t *testing.T) {
					body := browserControlReply(t, "change-local-password")
					if route == "local-login" {
						delete(body, "status")
					}
					var fields map[string]any
					if err := json.Unmarshal([]byte(failure), &fields); err != nil {
						t.Fatal(err)
					}
					for name, value := range fields {
						if name == "code" {
							name = key
						}
						body[name] = value
					}
					payload, err := json.Marshal(body)
					if err != nil {
						t.Fatal(err)
					}
					response := jsonResponse(200, string(payload))
					response.Header.Set("Retry-After", "1")
					err = callPasswordRPC(t, route, response)
					if _, ok := PasswordAdmissionFailure(err); ok {
						t.Fatal("mixed success acquired trusted retry metadata")
					}
				})
			}
		}
	}
}

func TestPasswordFailureDecoderAcceptsNewMetadata(t *testing.T) {
	for _, row := range []struct {
		name string
		body string
	}{
		{"n-1", credentialBusyBody},
		{"n", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable","request_id":"identity-req-1"}`},
		{"n-details", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable","request_id":"identity-req-1","details":{"retry_after":1}}`},
		{"n-rate", strings.TrimSuffix(credentialRateBody, "}") + `,"category":"rate_limited","request_id":"identity-req-2"}`},
	} {
		t.Run(row.name, func(t *testing.T) {
			response := jsonResponse(503, row.body)
			if row.name == "n-rate" {
				response = jsonResponse(429, row.body)
			}
			response.Header.Set("Retry-After", "1")
			err := callPasswordRPC(t, "local-login", response)
			if _, ok := PasswordAdmissionFailure(err); !ok {
				t.Fatal("compatible password failure was rejected")
			}
		})
	}
}

func TestPasswordFailureDecoderRejectsPartialMetadata(t *testing.T) {
	for _, row := range []struct {
		name string
		body string
	}{
		{"category-only", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable"}`},
		{"id-only", strings.TrimSuffix(credentialBusyBody, "}") + `,"request_id":"identity-req-1"}`},
		{"details-only", strings.TrimSuffix(credentialBusyBody, "}") + `,"details":{"a":1}}`},
		{"wrong-category", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"rate_limited","request_id":"identity-req-1"}`},
		{"unknown-category", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"forbidden","request_id":"identity-req-1"}`},
		{"empty-id", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable","request_id":""}`},
		{"unsafe-id", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable","request_id":"bad id!!"}`},
		{"long-id", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable","request_id":"` + strings.Repeat("a", 129) + `"}`},
		{"details-scalar", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable","request_id":"identity-req-1","details":1}`},
		{"details-array", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":"unavailable","request_id":"identity-req-1","details":[1]}`},
		{"canary-member", strings.TrimSuffix(credentialBusyBody, "}") + `,"private-token-canary":true}`},
	} {
		t.Run(row.name, func(t *testing.T) {
			response := jsonResponse(503, row.body)
			response.Header.Set("Retry-After", "1")
			err := callPasswordRPC(t, "local-login", response)
			if _, ok := PasswordAdmissionFailure(err); ok {
				t.Fatal("malformed failure acquired trusted retry metadata")
			}
		})
	}
}

func TestPasswordFailureSuccessRejectsReservedMetadata(t *testing.T) {
	for _, field := range []string{
		`"category":"unavailable"`, `"request_id":"identity-req-1"`,
		`"Category":"unavailable"`, `"Request_ID":"identity-req-1"`,
	} {
		if validPasswordSuccess([]byte(`{"access_token":"new-private-token","token_id":"token-2",` + field + `}`)) {
			t.Fatalf("success body with reserved %s was accepted", field)
		}
	}
	if !validPasswordSuccess([]byte(`{"access_token":"new-private-token","token_id":"token-2","details":{"a":1}}`)) {
		t.Fatal("clean success body was rejected")
	}
}

func TestPasswordFailureDecoderRejectsExplicitNullMetadata(t *testing.T) {
	for _, row := range []struct {
		name string
		body string
	}{
		{"null-category", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":null}`},
		{"null-id", strings.TrimSuffix(credentialBusyBody, "}") + `,"request_id":null}`},
		{"null-both", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":null,"request_id":null}`},
		{"null-details", strings.TrimSuffix(credentialBusyBody, "}") + `,"details":null}`},
		{"typed-category", strings.TrimSuffix(credentialBusyBody, "}") + `,"category":1}`},
		{"typed-id", strings.TrimSuffix(credentialBusyBody, "}") + `,"request_id":1}`},
	} {
		t.Run(row.name, func(t *testing.T) {
			response := jsonResponse(503, row.body)
			response.Header.Set("Retry-After", "1")
			err := callPasswordRPC(t, "local-login", response)
			if _, ok := PasswordAdmissionFailure(err); ok {
				t.Fatal("explicit null or mistyped metadata acquired trusted retry metadata")
			}
		})
	}
}

func TestPasswordFailureDecoderValidatesLegacyMetadata(t *testing.T) {
	t.Run("n-accepted", func(t *testing.T) {
		response := jsonResponse(400, `{"code":"unauthenticated","message":"denied","retryable":false,"category":"unauthenticated","request_id":"identity-req-1"}`)
		err := callPasswordRPC(t, "local-login", response)
		if !IsCode(err, "unauthenticated") {
			t.Fatal("new metadata on a legacy code was rejected")
		}
	})
	for _, row := range []struct {
		name string
		body string
	}{
		{"wrong-category", `{"code":"unauthenticated","message":"denied","retryable":false,"category":"forbidden","request_id":"identity-req-1"}`},
		{"null-category", `{"code":"unauthenticated","message":"denied","retryable":false,"category":null,"request_id":"identity-req-1"}`},
		{"null-id", `{"code":"unauthenticated","message":"denied","retryable":false,"category":"unauthenticated","request_id":null}`},
		{"partial", `{"code":"unauthenticated","message":"denied","retryable":false,"category":"unauthenticated"}`},
	} {
		t.Run(row.name, func(t *testing.T) {
			err := callPasswordRPC(t, "local-login", jsonResponse(400, row.body))
			var remote *RemoteError
			if errors.As(err, &remote) {
				t.Fatal("malformed metadata fell back into an unvalidated remote classification")
			}
			if _, ok := PasswordAdmissionFailure(err); ok {
				t.Fatal("malformed metadata acquired trusted retry metadata")
			}
		})
	}
}
