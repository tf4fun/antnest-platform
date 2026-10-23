package rpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

const (
	incarnationRPCRegisterPath   = "/internal/acp-incarnations/register"
	incarnationRPCID             = "12345678-1234-4abc-8abc-1234567890ab"
	incarnationRPCRegistrationID = "87654321-4321-4abc-9abc-ba0987654321"
	incarnationRPCReceiptID      = "abcdef01-2345-4abc-aabc-1234567890ab"
	incarnationRPCInspectPath    = "/internal/acp-incarnations/" + incarnationRPCRegistrationID
)

type incarnationRPCStub struct {
	registerCalls  int
	inspectCalls   int
	request        acpincarnation.RegisterRequest
	registrationID string
	register       func(context.Context, acpincarnation.RegisterRequest) (acpincarnation.Registration, error)
	inspect        func(context.Context, string) (acpincarnation.Inspection, error)
}

var _ AcpIncarnationService = (*incarnationRPCStub)(nil)

func (s *incarnationRPCStub) Register(ctx context.Context, input acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
	s.registerCalls++
	s.request = input
	if s.register != nil {
		return s.register(ctx, input)
	}
	return incarnationRPCRegistration(), nil
}

func (s *incarnationRPCStub) Inspect(ctx context.Context, id string) (acpincarnation.Inspection, error) {
	s.inspectCalls++
	s.registrationID = id
	if s.inspect != nil {
		return s.inspect(ctx, id)
	}
	return acpincarnation.Inspection{State: "unknown", RegistrationID: id, Reason: "unregistered"}, nil
}

func incarnationRPCToken(caller string) string {
	value := byte(1)
	switch caller {
	case "agent-controller":
		value = 2
	case "skill-registry":
		value = 3
	}
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, 32))
}

func incarnationRPCSecurity(t *testing.T) Security {
	t.Helper()
	callers := make(map[string][]string)
	for _, caller := range []string{"agent-acp-service", "agent-controller", "skill-registry"} {
		digest := sha256.Sum256([]byte(incarnationRPCToken(caller)))
		callers[caller] = []string{fmt.Sprintf("sha256:%x", digest)}
	}
	raw, err := json.Marshal(callers)
	if err != nil {
		t.Fatal("encode incarnation caller fixture failed")
	}
	receiver, err := serviceauth.ParseReceiver("runtime-controller", raw, false)
	if err != nil {
		t.Fatal("construct incarnation caller fixture failed")
	}
	return Security{Authentication: receiver}
}

func incarnationRPCHandler(t *testing.T, port *incarnationRPCStub) (*Handler, *fakeService, *preparationStub) {
	t.Helper()
	service, preparation := &fakeService{}, &preparationStub{}
	handler, err := NewHandlerWithAcpIncarnations(service, observation.NewHub(), time.Second, time.Minute, incarnationRPCSecurity(t), port, preparation)
	if err != nil {
		t.Fatal("construct incarnation RPC handler failed")
	}
	return handler, service, preparation
}

func incarnationRPCRegistration() acpincarnation.Registration {
	return acpincarnation.Registration{
		RegistrationID: incarnationRPCRegistrationID, MemberID: "acp-a", IncarnationID: incarnationRPCID,
	}
}

func incarnationRPCInput() map[string]any {
	return map[string]any{
		"member_id": "acp-a", "incarnation_id": incarnationRPCID, "registration_nonce": strings.Repeat("a", 64),
	}
}

func incarnationRPCJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal("encode incarnation wire fixture failed")
	}
	return string(raw)
}

func incarnationRPCRequest(method, path, body, caller string) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Content-Type", "application/json")
	if caller != "" {
		request.Header.Set(serviceauth.Header, "Bearer "+incarnationRPCToken(caller))
	}
	return request
}

func incarnationRPCServe(t *testing.T, handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(request.Context(), time.Second)
	defer cancel()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(ctx))
	return response
}

func incarnationRPCObject(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil || value == nil {
		t.Fatal("incarnation RPC did not return one JSON object")
	}
	if response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("incarnation RPC lost its private JSON response headers")
	}
	return value
}

func incarnationRPCError(t *testing.T, response *httptest.ResponseRecorder, status int, code string, retryable bool) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("incarnation RPC status=%d, want %d", response.Code, status)
	}
	value := incarnationRPCObject(t, response)
	message, ok := value["message"].(string)
	if len(value) != 3 || value["code"] != code || value["retryable"] != retryable || !ok || len([]rune(message)) < 1 || len([]rune(message)) > 512 {
		t.Fatal("incarnation RPC lost its strict fixed error shape")
	}
	if response.Body.Len() > 8192 {
		t.Fatal("incarnation RPC error exceeded its response byte limit")
	}
}

func incarnationRPCNoEffects(t *testing.T, port *incarnationRPCStub, service *fakeService, preparation *preparationStub) {
	t.Helper()
	if port.registerCalls != 0 || port.inspectCalls != 0 || service.initializeCalls != 0 || service.agentID != "" || service.command != "" || preparation.released || preparation.received.OwnerOperationID != "" {
		t.Fatal("rejected incarnation request reached a business port")
	}
}

type incarnationRPCBody struct {
	reader io.Reader
	reads  int
}

func (b *incarnationRPCBody) Read(value []byte) (int, error) {
	b.reads++
	return b.reader.Read(value)
}

func (*incarnationRPCBody) Close() error { return nil }

func TestAcpIncarnationRPCRegistrationAndInspectionHaveClosedWireShapes(t *testing.T) {
	port := &incarnationRPCStub{}
	handler, _, _ := incarnationRPCHandler(t, port)
	response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, incarnationRPCJSON(t, incarnationRPCInput()), "agent-acp-service"))
	if response.Code != http.StatusOK {
		t.Fatal("authenticated ACP registration was refused")
	}
	want := map[string]any{"registration_id": incarnationRPCRegistrationID, "member_id": "acp-a", "incarnation_id": incarnationRPCID}
	if !reflect.DeepEqual(incarnationRPCObject(t, response), want) || port.registerCalls != 1 || port.inspectCalls != 0 || port.request != (acpincarnation.RegisterRequest{MemberID: "acp-a", IncarnationID: incarnationRPCID, RegistrationNonce: strings.Repeat("a", 64)}) {
		t.Fatal("registration changed its exact request or response wire")
	}

	observed := time.Date(2026, 10, 23, 1, 2, 3, 123456789, time.UTC)
	for _, test := range []struct {
		name  string
		value acpincarnation.Inspection
		want  map[string]any
	}{
		{
			name:  "running",
			value: acpincarnation.Inspection{State: "running", RegistrationID: incarnationRPCRegistrationID, MemberID: "acp-a", IncarnationID: incarnationRPCID, ObservedAt: &observed},
			want:  map[string]any{"state": "running", "registration_id": incarnationRPCRegistrationID, "member_id": "acp-a", "incarnation_id": incarnationRPCID, "observed_at": "2026-10-23T01:02:03.123456789Z"},
		},
		{
			name:  "unknown",
			value: acpincarnation.Inspection{State: "unknown", RegistrationID: incarnationRPCRegistrationID, Reason: "unregistered"},
			want:  map[string]any{"state": "unknown", "registration_id": incarnationRPCRegistrationID, "reason": "unregistered"},
		},
		{
			name:  "stopped",
			value: acpincarnation.Inspection{State: "stopped", RegistrationID: incarnationRPCRegistrationID, MemberID: "acp-a", IncarnationID: incarnationRPCID, StopReceipt: &acpincarnation.StopReceipt{ReceiptID: incarnationRPCReceiptID, Reason: "container_restarted", ObservedAt: observed}},
			want:  map[string]any{"state": "stopped", "registration_id": incarnationRPCRegistrationID, "member_id": "acp-a", "incarnation_id": incarnationRPCID, "stop_receipt": map[string]any{"receipt_id": incarnationRPCReceiptID, "reason": "container_restarted", "observed_at": "2026-10-23T01:02:03.123456789Z"}},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			port := &incarnationRPCStub{inspect: func(context.Context, string) (acpincarnation.Inspection, error) { return test.value, nil }}
			handler, _, _ := incarnationRPCHandler(t, port)
			response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodGet, incarnationRPCInspectPath, "", "agent-acp-service"))
			if response.Code != http.StatusOK || !reflect.DeepEqual(incarnationRPCObject(t, response), test.want) || port.inspectCalls != 1 || port.registerCalls != 0 || port.registrationID != incarnationRPCRegistrationID {
				t.Fatal("inspection did not preserve its exact closed wire shape")
			}
		})
	}
}

func TestAcpIncarnationRPCAuthenticatesBeforeBodyAndBusinessPorts(t *testing.T) {
	for _, route := range []struct{ method, path string }{{http.MethodPost, incarnationRPCRegisterPath}, {http.MethodGet, incarnationRPCInspectPath}} {
		for _, caller := range []string{"", "agent-controller", "skill-registry"} {
			t.Run(route.method+"/"+caller, func(t *testing.T) {
				port := &incarnationRPCStub{}
				handler, service, preparation := incarnationRPCHandler(t, port)
				body := &incarnationRPCBody{reader: strings.NewReader("PRIVATE_UNAUTHENTICATED_BODY")}
				request := incarnationRPCRequest(route.method, route.path, "", caller)
				request.Body = body
				request.ContentLength = -1
				request.Header.Set("Content-Type", "text/plain")
				request.Header.Set("X-Antnest-Principal-ID", "pretend-acp")
				request.Header.Set("Antnest-Caller-Context", "PRIVATE_CALLER_CONTEXT")
				request.Header.Set("Authorization", "Bearer PRIVATE_USER_TOKEN")
				status, code := http.StatusForbidden, "caller_not_allowed"
				if caller == "" {
					status, code = http.StatusUnauthorized, "service_unauthenticated"
				}
				response := incarnationRPCServe(t, handler, request)
				incarnationRPCError(t, response, status, code, false)
				if body.reads != 0 {
					t.Fatal("incarnation authentication read an untrusted request body")
				}
				incarnationRPCNoEffects(t, port, service, preparation)
			})
		}
	}
}

func TestAcpIncarnationRPCPreservesControllerOnlyLifecycleGrants(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/internal/runtime-images/resolve"},
		{http.MethodGet, "/internal/runtimes"},
		{http.MethodGet, "/internal/runtimes/agent-1"},
		{http.MethodPost, "/internal/runtimes/agent-1/connection"},
		{http.MethodPost, "/internal/runtimes/agent-1/initialize"},
		{http.MethodPost, "/internal/runtimes/agent-1/update"},
		{http.MethodPost, "/internal/runtimes/agent-1/disable"},
		{http.MethodPost, "/internal/runtimes/agent-1/enable"},
		{http.MethodPost, "/internal/runtimes/agent-1/delete"},
		{http.MethodGet, "/internal/runtime-operations/request-1"},
		{http.MethodGet, "/internal/runtime-observations"},
		{http.MethodGet, "/internal/runtime-observations/watch"},
		{http.MethodPost, "/internal/runtimes/agent-1/skill-sets/prepare"},
		{http.MethodGet, "/internal/runtimes/agent-1/skill-sets/preparations/request-1"},
		{http.MethodPost, "/internal/runtimes/agent-1/skill-sets/preparations/request-1/release"},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			port := &incarnationRPCStub{}
			handler, service, preparation := incarnationRPCHandler(t, port)
			body := &incarnationRPCBody{reader: strings.NewReader(`{"owner_operation_id":"must-not-prepare"}`)}
			request := incarnationRPCRequest(route.method, route.path, "", "agent-acp-service")
			request.Body = body
			request.ContentLength = -1
			response := incarnationRPCServe(t, handler, request)
			if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"caller_not_allowed"`) || body.reads != 0 {
				t.Fatal("ACP grant escaped into an existing Controller route")
			}
			incarnationRPCNoEffects(t, port, service, preparation)
		})
	}
	port := &incarnationRPCStub{}
	handler, _, _ := incarnationRPCHandler(t, port)
	for _, handler := range []http.Handler{handler, incarnationRPCLegacyHandler(t)} {
		response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodGet, "/internal/runtimes", "", "agent-controller"))
		if response.Code != http.StatusOK {
			t.Fatal("original Controller grant or NewHandler API changed")
		}
	}
}

func incarnationRPCLegacyHandler(t *testing.T) *Handler {
	t.Helper()
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Second, incarnationRPCSecurity(t), &preparationStub{})
	if err != nil {
		t.Fatal("original RPC handler constructor changed")
	}
	return handler
}

func TestAcpIncarnationRPCRequiresExactMethodsAndPaths(t *testing.T) {
	for _, route := range []struct{ path, allowed string }{{incarnationRPCRegisterPath, http.MethodPost}, {incarnationRPCInspectPath, http.MethodGet}} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodHead, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
			if method == route.allowed {
				continue
			}
			t.Run(method+route.path, func(t *testing.T) {
				port := &incarnationRPCStub{}
				handler, service, preparation := incarnationRPCHandler(t, port)
				response := incarnationRPCServe(t, handler, incarnationRPCRequest(method, route.path, incarnationRPCJSON(t, incarnationRPCInput()), "agent-acp-service"))
				incarnationRPCError(t, response, http.StatusMethodNotAllowed, "method_not_allowed", false)
				incarnationRPCNoEffects(t, port, service, preparation)
			})
		}
	}
	for _, path := range []string{incarnationRPCRegisterPath + "/", incarnationRPCInspectPath + "/", incarnationRPCInspectPath + "/extra", "/internal/acp-incarnations-extra/register"} {
		t.Run(path, func(t *testing.T) {
			port := &incarnationRPCStub{}
			handler, service, preparation := incarnationRPCHandler(t, port)
			response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodGet, path, "", "agent-controller"))
			if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), `"code":"route_not_found"`) {
				t.Fatal("incarnation route accepted a different path")
			}
			incarnationRPCNoEffects(t, port, service, preparation)
		})
	}
}

func TestAcpIncarnationRPCRejectsQueriesAndInspectionBodies(t *testing.T) {
	for _, route := range []struct{ method, path string }{{http.MethodPost, incarnationRPCRegisterPath}, {http.MethodGet, incarnationRPCInspectPath}} {
		for _, query := range []string{"?url=PRIVATE_QUERY_CANARY", "?registration_id=" + incarnationRPCRegistrationID, "?member_id=acp-a&member_id=acp-b"} {
			t.Run(route.method+query, func(t *testing.T) {
				port := &incarnationRPCStub{}
				handler, service, preparation := incarnationRPCHandler(t, port)
				body := ""
				if route.method == http.MethodPost {
					body = incarnationRPCJSON(t, incarnationRPCInput())
				}
				response := incarnationRPCServe(t, handler, incarnationRPCRequest(route.method, route.path+query, body, "agent-acp-service"))
				incarnationRPCError(t, response, http.StatusBadRequest, "invalid_request", false)
				if strings.Contains(response.Body.String(), "PRIVATE_QUERY_CANARY") {
					t.Fatal("invalid query leaked through the error response")
				}
				incarnationRPCNoEffects(t, port, service, preparation)
			})
		}
	}
	for _, body := range []string{"{}", " ", "null"} {
		for _, length := range []int64{-1, int64(len(body))} {
			t.Run(fmt.Sprintf("inspection-body/%q/%d", body, length), func(t *testing.T) {
				port := &incarnationRPCStub{}
				handler, service, preparation := incarnationRPCHandler(t, port)
				request := incarnationRPCRequest(http.MethodGet, incarnationRPCInspectPath, body, "agent-acp-service")
				request.ContentLength = length
				response := incarnationRPCServe(t, handler, request)
				incarnationRPCError(t, response, http.StatusBadRequest, "invalid_request", false)
				incarnationRPCNoEffects(t, port, service, preparation)
			})
		}
	}
}

func TestAcpIncarnationRPCRejectsAmbiguousMediaBeforeReading(t *testing.T) {
	for _, media := range []string{"", "text/plain", "application/problem+json", "application/json; charset=latin1", "application/json; extra=utf-8", "application/json, application/json", "duplicate", "gzip"} {
		t.Run(media, func(t *testing.T) {
			port := &incarnationRPCStub{}
			handler, service, preparation := incarnationRPCHandler(t, port)
			body := &incarnationRPCBody{reader: strings.NewReader(incarnationRPCJSON(t, incarnationRPCInput()))}
			request := incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, "", "agent-acp-service")
			request.Body = body
			request.ContentLength = -1
			request.Header.Del("Content-Type")
			switch media {
			case "duplicate":
				request.Header.Add("Content-Type", "application/json")
				request.Header.Add("Content-Type", "application/json")
			case "gzip":
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Content-Encoding", "gzip")
			default:
				if media != "" {
					request.Header.Set("Content-Type", media)
				}
			}
			response := incarnationRPCServe(t, handler, request)
			incarnationRPCError(t, response, http.StatusUnsupportedMediaType, "unsupported_media_type", false)
			if body.reads != 0 {
				t.Fatal("ambiguous media was read before rejection")
			}
			incarnationRPCNoEffects(t, port, service, preparation)
		})
	}
}

func TestAcpIncarnationRPCRejectsNonStrictRegistrationJSON(t *testing.T) {
	valid := incarnationRPCJSON(t, incarnationRPCInput())
	cases := []struct{ name, body string }{
		{"empty", ""}, {"null", "null"}, {"array", "[]"}, {"scalar", `"acp-a"`}, {"empty-object", "{}"},
		{"two-values", valid + " {}"}, {"bom", "\ufeff" + valid}, {"invalid-utf8", "{\"member_id\":\"\xff\"}"},
		{"duplicate-member", strings.TrimSuffix(valid, "}") + `,"member_id":"acp-b"}`},
		{"duplicate-incarnation", strings.TrimSuffix(valid, "}") + `,"incarnation_id":"` + incarnationRPCID + `"}`},
		{"duplicate-nonce", strings.TrimSuffix(valid, "}") + `,"registration_nonce":"` + strings.Repeat("a", 64) + `"}`},
		{"case-alias", strings.TrimSuffix(valid, "}") + `,"Member_ID":"acp-b"}`},
	}
	for _, field := range []string{"member_id", "incarnation_id", "registration_nonce"} {
		missing := incarnationRPCInput()
		delete(missing, field)
		cases = append(cases, struct{ name, body string }{"missing-" + field, incarnationRPCJSON(t, missing)})
		for index, value := range []any{nil, false, 7, []any{}, map[string]any{}} {
			input := incarnationRPCInput()
			input[field] = value
			cases = append(cases, struct{ name, body string }{fmt.Sprintf("type-%s-%d", field, index), incarnationRPCJSON(t, input)})
		}
		alias := incarnationRPCInput()
		delete(alias, field)
		alias[strings.ToUpper(field)] = incarnationRPCInput()[field]
		cases = append(cases, struct{ name, body string }{"alias-" + field, incarnationRPCJSON(t, alias)})
	}
	for _, field := range []string{"url", "selector", "credential", "epoch", "quiescent", "organization_id", "unknown"} {
		input := incarnationRPCInput()
		input[field] = "PRIVATE_UNKNOWN_FIELD"
		cases = append(cases, struct{ name, body string }{"extra-" + field, incarnationRPCJSON(t, input)})
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			port := &incarnationRPCStub{}
			handler, service, preparation := incarnationRPCHandler(t, port)
			response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, test.body, "agent-acp-service"))
			incarnationRPCError(t, response, http.StatusBadRequest, "invalid_request", false)
			if strings.Contains(response.Body.String(), "PRIVATE_UNKNOWN_FIELD") {
				t.Fatal("strict JSON rejection reflected private input")
			}
			incarnationRPCNoEffects(t, port, service, preparation)
		})
	}
}

func TestAcpIncarnationRPCValidatesScalarBoundariesBeforePorts(t *testing.T) {
	for _, test := range []struct{ field, value string }{
		{"member_id", ""}, {"member_id", "-a"}, {"member_id", "a-"}, {"member_id", "A"}, {"member_id", "a.b"}, {"member_id", " acp-a"}, {"member_id", "acp-a\n"}, {"member_id", strings.Repeat("a", 65)},
		{"incarnation_id", strings.ToUpper(incarnationRPCID)}, {"incarnation_id", strings.Replace(incarnationRPCID, "-4abc-", "-1abc-", 1)}, {"incarnation_id", strings.Replace(incarnationRPCID, "-8abc-", "-7abc-", 1)}, {"incarnation_id", incarnationRPCID + "\n"}, {"incarnation_id", incarnationRPCID[:35]},
		{"registration_nonce", ""}, {"registration_nonce", strings.Repeat("a", 63)}, {"registration_nonce", strings.Repeat("a", 65)}, {"registration_nonce", strings.Repeat("A", 64)}, {"registration_nonce", strings.Repeat("g", 64)}, {"registration_nonce", strings.Repeat("a", 64) + "\n"},
	} {
		t.Run(test.field+"/"+test.value, func(t *testing.T) {
			port := &incarnationRPCStub{}
			handler, service, preparation := incarnationRPCHandler(t, port)
			input := incarnationRPCInput()
			input[test.field] = test.value
			response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, incarnationRPCJSON(t, input), "agent-acp-service"))
			incarnationRPCError(t, response, http.StatusBadRequest, "invalid_request", false)
			incarnationRPCNoEffects(t, port, service, preparation)
		})
	}
	for _, id := range []string{"not-a-uuid", strings.ToUpper(incarnationRPCRegistrationID), strings.Replace(incarnationRPCRegistrationID, "-4abc-", "-1abc-", 1), incarnationRPCRegistrationID[:35]} {
		t.Run("inspect/"+id, func(t *testing.T) {
			port := &incarnationRPCStub{}
			handler, service, preparation := incarnationRPCHandler(t, port)
			response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodGet, "/internal/acp-incarnations/"+id, "", "agent-acp-service"))
			incarnationRPCError(t, response, http.StatusBadRequest, "invalid_request", false)
			incarnationRPCNoEffects(t, port, service, preparation)
		})
	}
	for _, member := range []string{"a", strings.Repeat("a", 64)} {
		t.Run("valid-member/"+member, func(t *testing.T) {
			port := &incarnationRPCStub{register: func(_ context.Context, request acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
				return acpincarnation.Registration{RegistrationID: incarnationRPCRegistrationID, MemberID: request.MemberID, IncarnationID: request.IncarnationID}, nil
			}}
			handler, _, _ := incarnationRPCHandler(t, port)
			input := incarnationRPCInput()
			input["member_id"] = member
			response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, incarnationRPCJSON(t, input), "agent-acp-service"))
			if response.Code != http.StatusOK || port.registerCalls != 1 || incarnationRPCObject(t, response)["member_id"] != member {
				t.Fatal("valid catalog label boundary was refused")
			}
		})
	}
}

func TestAcpIncarnationRPCEnforcesFourKiBRequestLimit(t *testing.T) {
	valid := incarnationRPCJSON(t, incarnationRPCInput())
	for _, size := range []int{4096, 4097} {
		for _, unknownLength := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/unknown-length-%t", size, unknownLength), func(t *testing.T) {
				port := &incarnationRPCStub{}
				handler, service, preparation := incarnationRPCHandler(t, port)
				body := valid + strings.Repeat(" ", size-len(valid))
				request := incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, body, "agent-acp-service")
				if unknownLength {
					request.ContentLength = -1
				}
				response := incarnationRPCServe(t, handler, request)
				if size == 4096 {
					if response.Code != http.StatusOK || port.registerCalls != 1 {
						t.Fatal("request at the exact byte limit was refused")
					}
					incarnationRPCObject(t, response)
					return
				}
				incarnationRPCError(t, response, http.StatusRequestEntityTooLarge, "request_too_large", false)
				incarnationRPCNoEffects(t, port, service, preparation)
			})
		}
	}
}

func TestAcpIncarnationRPCUsesFixedFailureMappingWithoutPrivateCauses(t *testing.T) {
	for _, test := range []struct {
		code      string
		status    int
		retryable bool
	}{
		{"invalid_request", 400, false}, {"acp_member_not_allowed", 403, false}, {"acp_incarnation_unverified", 403, false}, {"acp_incarnation_conflict", 409, false},
		{"acp_registration_unavailable", 503, true}, {"acp_registry_unavailable", 503, true}, {"deadline_exceeded", 504, true}, {"internal_error", 500, true},
	} {
		t.Run(test.code, func(t *testing.T) {
			var original string
			for _, marker := range []string{"PRIVATE_DATABASE_CAUSE", "PRIVATE_DOCKER_CAUSE"} {
				port := &incarnationRPCStub{register: func(context.Context, acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
					return acpincarnation.Registration{}, errors.Join(&acpincarnation.Failure{Code: test.code}, errors.New(marker))
				}}
				handler, _, _ := incarnationRPCHandler(t, port)
				response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, incarnationRPCJSON(t, incarnationRPCInput()), "agent-acp-service"))
				incarnationRPCError(t, response, test.status, test.code, test.retryable)
				if port.registerCalls != 1 || strings.Contains(response.Body.String(), marker) {
					t.Fatal("typed failure lost its port call or reflected its private cause")
				}
				if original != "" && response.Body.String() != original {
					t.Fatal("public failure changed with its private cause")
				}
				original = response.Body.String()
			}
		})
	}
	for _, failure := range []error{errors.New("PRIVATE_UNKNOWN_CAUSE"), &acpincarnation.Failure{Code: "PRIVATE_UNKNOWN_CODE"}, &acpincarnation.Failure{Code: "acp_probe_intent_mismatch"}} {
		port := &incarnationRPCStub{inspect: func(context.Context, string) (acpincarnation.Inspection, error) {
			return acpincarnation.Inspection{}, failure
		}}
		handler, _, _ := incarnationRPCHandler(t, port)
		response := incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodGet, incarnationRPCInspectPath, "", "agent-acp-service"))
		incarnationRPCError(t, response, http.StatusInternalServerError, "internal_error", true)
		if strings.Contains(response.Body.String(), "PRIVATE_") || strings.Contains(response.Body.String(), "acp_probe_intent_mismatch") {
			t.Fatal("unknown port failure escaped the fixed RC error catalog")
		}
	}
	port := &incarnationRPCStub{inspect: func(context.Context, string) (acpincarnation.Inspection, error) {
		return acpincarnation.Inspection{}, context.DeadlineExceeded
	}}
	handler, _, _ := incarnationRPCHandler(t, port)
	incarnationRPCError(t, incarnationRPCServe(t, handler, incarnationRPCRequest(http.MethodGet, incarnationRPCInspectPath, "", "agent-acp-service")), http.StatusGatewayTimeout, "deadline_exceeded", true)
}

func TestAcpIncarnationRPCRejectsOversizedPortResponsesWithoutLeaking(t *testing.T) {
	private := strings.Repeat("PRIVATE_PORT_RESPONSE_CANARY", 400)
	for _, route := range []struct{ method, path string }{{http.MethodPost, incarnationRPCRegisterPath}, {http.MethodGet, incarnationRPCInspectPath}} {
		t.Run(route.method, func(t *testing.T) {
			port := &incarnationRPCStub{
				register: func(context.Context, acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
					value := incarnationRPCRegistration()
					value.MemberID = private
					return value, nil
				},
				inspect: func(context.Context, string) (acpincarnation.Inspection, error) {
					return acpincarnation.Inspection{State: "unknown", RegistrationID: incarnationRPCRegistrationID, Reason: private}, nil
				},
			}
			handler, _, _ := incarnationRPCHandler(t, port)
			body := ""
			if route.method == http.MethodPost {
				body = incarnationRPCJSON(t, incarnationRPCInput())
			}
			response := incarnationRPCServe(t, handler, incarnationRPCRequest(route.method, route.path, body, "agent-acp-service"))
			incarnationRPCError(t, response, http.StatusInternalServerError, "internal_error", true)
			if strings.Contains(response.Body.String(), "PRIVATE_PORT_RESPONSE_CANARY") || port.registerCalls+port.inspectCalls != 1 {
				t.Fatal("oversized port response leaked or bypassed the selected port")
			}
		})
	}
}

func TestAcpIncarnationRPCSuppressesObservedPrivatePayloads(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := tracetest.NewSpanRecorder()
	rpcTestTracerProvider.RegisterSpanProcessor(recorder)
	t.Cleanup(func() { rpcTestTracerProvider.UnregisterSpanProcessor(recorder) })
	port := &incarnationRPCStub{}
	handler, _, _ := incarnationRPCHandler(t, port)
	observed := telemetry.HTTPHandler(handler)
	for _, test := range []struct {
		method, path, body, caller string
		status                     int
		code                       string
	}{
		{http.MethodPost, incarnationRPCRegisterPath, incarnationRPCJSON(t, incarnationRPCInput()), "agent-acp-service", 200, ""},
		{http.MethodGet, incarnationRPCInspectPath, "", "agent-acp-service", 200, ""},
		{http.MethodPost, incarnationRPCRegisterPath, `{"credential":"PRIVATE_PAYLOAD_CANARY"}`, "agent-acp-service", 400, "invalid_request"},
		{http.MethodGet, incarnationRPCInspectPath + "?credential=PRIVATE_QUERY_CANARY", "", "agent-acp-service", 400, "invalid_request"},
		{http.MethodPost, incarnationRPCRegisterPath, `{"credential":"PRIVATE_UNAUTHENTICATED_CANARY"}`, "", 401, "service_unauthenticated"},
	} {
		response := incarnationRPCServe(t, observed, incarnationRPCRequest(test.method, test.path, test.body, test.caller))
		if test.code != "" {
			incarnationRPCError(t, response, test.status, test.code, false)
		} else if response.Code != test.status {
			t.Fatal("observed incarnation request changed its business result")
		} else {
			incarnationRPCObject(t, response)
		}
	}
	port.register = func(context.Context, acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
		return acpincarnation.Registration{}, errors.Join(&acpincarnation.Failure{Code: "acp_registry_unavailable"}, errors.New("PRIVATE_FAILURE_CAUSE_CANARY"))
	}
	response := incarnationRPCServe(t, observed, incarnationRPCRequest(http.MethodPost, incarnationRPCRegisterPath, incarnationRPCJSON(t, incarnationRPCInput()), "agent-acp-service"))
	incarnationRPCError(t, response, http.StatusServiceUnavailable, "acp_registry_unavailable", true)
	spans := recorder.Ended()
	if len(spans) == 0 {
		t.Log("warning: no spans were collected; payload suppression diagnostics are unavailable")
	}
	for _, span := range spans {
		text := fmt.Sprint(span.Attributes(), span.Events())
		for _, marker := range []string{"antnest.payload.json", strings.Repeat("a", 64), incarnationRPCToken("agent-acp-service"), "PRIVATE_PAYLOAD_CANARY", "PRIVATE_QUERY_CANARY", "PRIVATE_UNAUTHENTICATED_CANARY", "PRIVATE_FAILURE_CAUSE_CANARY"} {
			if strings.Contains(text, marker) {
				t.Fatal("observed incarnation telemetry captured a private payload or cause")
			}
		}
	}
}
