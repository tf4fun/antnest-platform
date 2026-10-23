package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnationprobe"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	platformdocker "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/rpc"
)

func TestAcpIncarnationRPCPostgresRoundTrip(t *testing.T) {
	// The existing fixture owns schema removal and both pools. Register this
	// last-observer first so it checks their actual closure after that cleanup.
	var database, lockDatabase *sql.DB
	t.Cleanup(func() {
		for _, pool := range []*sql.DB{database, lockDatabase} {
			if pool != nil && (pool.Stats().OpenConnections != 0 || pool.Stats().InUse != 0) {
				t.Error("incarnation component fixture retained a PostgreSQL connection")
			}
		}
	})
	store, database, ctx := integrationRepository(t)
	lockDatabase = store.lockDatabase
	const scope = "acp-incarnation-rpc-scope"
	const selector = "owned-acp-member"
	const network = "acp-owner-network"
	const engine = "incarnation-fixture-engine"
	const started = "2026-10-23T09:15:16.123456789Z"
	containerID := strings.Repeat("a", 64)
	input := acpincarnation.RegisterRequest{
		MemberID: "acp-a", IncarnationID: acpIncarnationUUID(2001), RegistrationNonce: strings.Repeat("e", 64),
	}
	var fixtureErrors, probeCalls atomic.Int32
	probeInputs := make(chan acpincarnation.ProbeRequest, 1)
	probe := acpIncarnationRPCStartServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probeCalls.Add(1)
		raw, readErr := io.ReadAll(io.LimitReader(r.Body, 4097))
		closeErr := r.Body.Close()
		_, localPort, addressErr := net.SplitHostPort(r.Context().Value(http.LocalAddrContextKey).(net.Addr).String())
		var request acpincarnation.ProbeRequest
		var fields map[string]json.RawMessage
		valid := readErr == nil && closeErr == nil && len(raw) <= 4096 && addressErr == nil &&
			r.Method == http.MethodPost && r.URL.EscapedPath() == "/internal/acp-owner/incarnation/probe" && r.URL.RawQuery == "" &&
			r.Host == net.JoinHostPort("acp-owner.invalid", localPort) && r.Header.Get("Content-Type") == "application/json" &&
			len(r.Header.Values(serviceauth.Header)) == 1 && r.Header.Get(serviceauth.Header) == "Bearer "+acpIncarnationRPCToken("probe-peer") &&
			serviceauth.DecodeObject(raw, &request) == nil && json.Unmarshal(raw, &fields) == nil && len(fields) == 4 &&
			request.MemberID == input.MemberID && request.IncarnationID == input.IncarnationID &&
			request.RegistrationNonce == input.RegistrationNonce && acpincarnation.ValidNonce(request.Challenge)
		for _, header := range []string{"Authorization", "Cookie", "Antnest-Caller-Context", "X-Antnest-Principal-ID"} {
			valid = valid && r.Header.Get(header) == ""
		}
		if !valid {
			fixtureErrors.Add(1)
			acpIncarnationRPCWriteFixture(w, http.StatusBadRequest, map[string]string{"code": "invalid_fixture_probe"}, &fixtureErrors)
			return
		}
		select {
		case probeInputs <- request:
		default:
			fixtureErrors.Add(1)
		}
		acpIncarnationRPCWriteFixture(w, http.StatusOK, request, &fixtureErrors)
	}))
	probeURL, err := url.Parse(probe.server.URL)
	if err != nil {
		t.Fatal("parse private probe fixture origin failed")
	}
	member := acpincarnation.Member{ID: input.MemberID, Selector: selector, Network: network, Origin: "http://" + net.JoinHostPort("acp-owner.invalid", probeURL.Port())}
	var stateMu sync.Mutex
	platformState := struct {
		engine      string
		running     bool
		unavailable bool
	}{engine: engine, running: true}
	docker := acpIncarnationRPCStartServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stateMu.Lock()
		state := platformState
		stateMu.Unlock()
		if r.Method != http.MethodGet || r.URL.RawQuery != "" {
			fixtureErrors.Add(1)
			acpIncarnationRPCWriteFixture(w, http.StatusBadRequest, map[string]string{"message": "unexpected fixture request"}, &fixtureErrors)
			return
		}
		if state.unavailable {
			acpIncarnationRPCWriteFixture(w, http.StatusServiceUnavailable, map[string]string{"message": "PRIVATE_PLATFORM_FIXTURE_CAUSE"}, &fixtureErrors)
			return
		}
		switch r.URL.EscapedPath() {
		case "/v1.47/info":
			acpIncarnationRPCWriteFixture(w, http.StatusOK, map[string]string{"ID": state.engine}, &fixtureErrors)
		case "/v1.47/containers/" + selector + "/json", "/v1.47/containers/" + containerID + "/json":
			acpIncarnationRPCWriteFixture(w, http.StatusOK, map[string]any{
				"Id":              containerID,
				"State":           map[string]any{"Running": state.running, "StartedAt": started},
				"NetworkSettings": map[string]any{"Networks": map[string]any{network: map[string]string{"IPAddress": "127.0.0.1"}}},
			}, &fixtureErrors)
		default:
			fixtureErrors.Add(1)
			acpIncarnationRPCWriteFixture(w, http.StatusNotFound, map[string]string{"message": "unexpected fixture path"}, &fixtureErrors)
		}
	}))
	dockerTransport := acpIncarnationRPCNewTransport(t)
	dockerClient, err := platformdocker.NewHTTPClient(&http.Client{Transport: dockerTransport}, docker.server.URL)
	if err != nil {
		t.Fatal("construct real Docker HTTP adapter failed")
	}
	platform, err := platformdocker.NewAcpIncarnationPlatform(dockerClient)
	if err != nil {
		t.Fatal("construct incarnation platform adapter failed")
	}
	prober, err := acpincarnationprobe.New(acpIncarnationRPCOutbound(t))
	if err != nil {
		t.Fatal("construct real authenticated private probe client failed")
	}
	service, err := acpincarnation.New(scope, []acpincarnation.Member{member}, store, platform, prober)
	if err != nil {
		t.Fatal("construct incarnation application service failed")
	}
	handler, err := rpc.NewHandlerWithAcpIncarnations(acpIncarnationRPCUnusedRuntime{}, observation.NewHub(), time.Second, 10*time.Second, acpIncarnationRPCSecurity(t), service)
	if err != nil {
		t.Fatal("construct owning-service incarnation RPC failed")
	}
	rc := acpIncarnationRPCStartServer(t, handler)
	callerTransport := acpIncarnationRPCNewTransport(t)
	client := &http.Client{Transport: callerTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	registerPath := "/internal/acp-incarnations/register"
	unknownPath := "/internal/acp-incarnations/" + acpIncarnationUUID(2002)
	for _, caller := range []string{"", "agent-controller", "skill-registry"} {
		for _, method := range []string{http.MethodPost, http.MethodGet} {
			path, body := unknownPath, any(nil)
			if method == http.MethodPost {
				path, body = registerPath, input
			}
			response := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, method, path, body, caller)
			status, code := http.StatusForbidden, "caller_not_allowed"
			if caller == "" {
				status, code = http.StatusUnauthorized, "service_unauthenticated"
			}
			response.assertFailure(t, status, code)
		}
	}
	if dockerTransport.calls.Load() != 0 || probeCalls.Load() != 0 {
		t.Fatal("unauthorized workload reached Docker or the private probe")
	}
	acpIncarnationAssertCount(t, database, ctx, 0)
	unknown := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, http.MethodGet, unknownPath, nil, "agent-acp-service")
	unknown.assertUnknown(t, acpIncarnationUUID(2002), "unregistered")
	if dockerTransport.calls.Load() != 0 || probeCalls.Load() != 0 {
		t.Fatal("unregistered inspection queried the platform")
	}
	registrationResponse := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, http.MethodPost, registerPath, input, "agent-acp-service")
	var registration acpincarnation.Registration
	registrationResponse.decode(t, http.StatusOK, &registration)
	if len(registrationResponse.fields) != 3 || !acpincarnation.ValidUUID(registration.RegistrationID) || registration.MemberID != input.MemberID || registration.IncarnationID != input.IncarnationID || probeCalls.Load() != 1 {
		t.Fatal("real registration did not preserve the authenticated process tuple")
	}
	select {
	case challenge := <-probeInputs:
		if challenge.MemberID != input.MemberID || challenge.IncarnationID != input.IncarnationID || challenge.RegistrationNonce != input.RegistrationNonce || !acpincarnation.ValidNonce(challenge.Challenge) {
			t.Fatal("private challenge did not bind the original registration intent")
		}
	default:
		t.Fatal("registration did not finish its actual private HTTP probe")
	}
	var digest []byte
	var savedEngine, savedContainer, savedStart, startType, rawRecord string
	if err := database.QueryRowContext(ctx, `
SELECT nonce_digest,engine_id,container_id,started_at,pg_typeof(started_at)::text,to_jsonb(r)::text
FROM runtime_controller.acp_incarnation_registrations r
WHERE controller_scope=$1 AND registration_id=$2`, scope, registration.RegistrationID).
		Scan(&digest, &savedEngine, &savedContainer, &savedStart, &startType, &rawRecord); err != nil {
		t.Fatal("read actual persisted RPC registration failed")
	}
	expectedDigest := sha256.Sum256([]byte(input.RegistrationNonce))
	if len(digest) != 32 || !bytes.Equal(digest, expectedDigest[:]) || savedEngine != engine || savedContainer != containerID || savedStart != started || startType != "text" || strings.Contains(rawRecord, input.RegistrationNonce) {
		t.Fatal("RPC registration lost its digest-only storage or nanosecond platform binding")
	}
	acpIncarnationAssertCount(t, database, ctx, 1)
	registeredRows := acpIncarnationRows(t, database, ctx)
	platformCalls := dockerTransport.calls.Load()
	stateMu.Lock()
	platformState.unavailable = true
	stateMu.Unlock()
	replay := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, http.MethodPost, registerPath, input, "agent-acp-service")
	var replayed acpincarnation.Registration
	replay.decode(t, http.StatusOK, &replayed)
	if replayed != registration || dockerTransport.calls.Load() != platformCalls || probeCalls.Load() != 1 {
		t.Fatal("durable registration replay consulted unavailable platform facts or replaced its receipt")
	}
	inspectPath := "/internal/acp-incarnations/" + registration.RegistrationID
	stateMu.Lock()
	platformState.unavailable = false
	stateMu.Unlock()
	runningResponse := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, http.MethodGet, inspectPath, nil, "agent-acp-service")
	var running acpincarnation.Inspection
	runningResponse.decode(t, http.StatusOK, &running)
	if len(runningResponse.fields) != 5 || running.State != "running" || running.RegistrationID != registration.RegistrationID || running.MemberID != input.MemberID || running.IncarnationID != input.IncarnationID || running.ObservedAt == nil || running.ObservedAt.IsZero() || running.StopReceipt != nil {
		t.Fatal("running inspection lost its exact registered identity")
	}
	stateMu.Lock()
	platformState.unavailable = true
	stateMu.Unlock()
	unavailable := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, http.MethodGet, inspectPath, nil, "agent-acp-service")
	unavailable.assertUnknown(t, registration.RegistrationID, "platform_unavailable")
	if strings.Contains(string(unavailable.raw), "PRIVATE_PLATFORM_FIXTURE_CAUSE") || acpIncarnationRows(t, database, ctx) != registeredRows {
		t.Fatal("platform failure disclosed its cause or changed the persisted registration")
	}
	stateMu.Lock()
	platformState.unavailable = false
	platformState.running = false
	stateMu.Unlock()
	stoppedResponse := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, http.MethodGet, inspectPath, nil, "agent-acp-service")
	var stopped acpincarnation.Inspection
	stoppedResponse.decode(t, http.StatusOK, &stopped)
	if len(stoppedResponse.fields) != 5 || stopped.State != "stopped" || stopped.RegistrationID != registration.RegistrationID || stopped.MemberID != input.MemberID || stopped.IncarnationID != input.IncarnationID || stopped.ObservedAt != nil || stopped.StopReceipt == nil || !acpincarnation.ValidUUID(stopped.StopReceipt.ReceiptID) || stopped.StopReceipt.Reason != "container_stopped" || stopped.StopReceipt.ObservedAt.IsZero() {
		t.Fatal("positive stop did not produce the exact persisted stop wire")
	}
	var receiptID, reason string
	var stoppedAt time.Time
	if err := database.QueryRowContext(ctx, `
SELECT stop_receipt_id,stop_reason,stopped_at FROM runtime_controller.acp_incarnation_registrations
WHERE controller_scope=$1 AND registration_id=$2`, scope, registration.RegistrationID).Scan(&receiptID, &reason, &stoppedAt); err != nil {
		t.Fatal("read committed first stop receipt failed")
	}
	if receiptID != stopped.StopReceipt.ReceiptID || reason != stopped.StopReceipt.Reason || !stoppedAt.Equal(stopped.StopReceipt.ObservedAt) {
		t.Fatal("HTTP stop response did not use the actual PostgreSQL first receipt")
	}
	firstStop := acpIncarnationRows(t, database, ctx)
	platformCalls = dockerTransport.calls.Load()
	stateMu.Lock()
	platformState.engine = "replacement-engine"
	platformState.running = true
	stateMu.Unlock()
	for _, platformClosed := range []bool{false, true} {
		if platformClosed {
			// This is a genuinely closed TCP endpoint, not another synthetic
			// platform status. Durable stop lookup must avoid even a new attempt.
			docker.close(t)
		}
		response := acpIncarnationRPCCall(t, ctx, client, rc.server.URL, http.MethodGet, inspectPath, nil, "agent-acp-service")
		var original acpincarnation.Inspection
		response.decode(t, http.StatusOK, &original)
		if original.State != "stopped" || original.RegistrationID != stopped.RegistrationID || original.MemberID != stopped.MemberID || original.IncarnationID != stopped.IncarnationID || original.StopReceipt == nil || *original.StopReceipt != *stopped.StopReceipt || dockerTransport.calls.Load() != platformCalls || probeCalls.Load() != 1 {
			t.Fatal("persisted first stop depended on a replacement or unavailable platform")
		}
	}
	if acpIncarnationRows(t, database, ctx) != firstStop || fixtureErrors.Load() != 0 {
		t.Fatal("component changed its immutable record or violated a real HTTP fixture")
	}
	acpIncarnationAssertCount(t, database, ctx, 1)
	if database.Stats().InUse != 0 || lockDatabase.Stats().InUse != 0 || callerTransport.active.Load() != 0 || callerTransport.bodies.Load() != 0 || dockerTransport.active.Load() != 0 || dockerTransport.bodies.Load() != 0 {
		t.Fatal("completed component retained actual SQL or HTTP work")
	}
	callerTransport.CloseIdleConnections()
	dockerTransport.CloseIdleConnections()
	rc.close(t)
	probe.close(t)
	docker.close(t)
	if fixtureErrors.Load() != 0 {
		t.Fatal("component HTTP fixture reported a late response or cleanup failure")
	}
}

// Embedding the existing port keeps all ordinary Runtime methods unavailable:
// an accidental dispatch to one cannot masquerade as a successful fake call.
type acpIncarnationRPCUnusedRuntime struct{ rpc.Service }

func acpIncarnationRPCToken(caller string) string {
	value := byte(1)
	switch caller {
	case "agent-controller":
		value = 2
	case "skill-registry":
		value = 3
	case "probe-peer":
		value = 4
	}
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, 32))
}

func acpIncarnationRPCSecurity(t *testing.T) rpc.Security {
	t.Helper()
	callers := make(map[string][]string)
	for _, caller := range []string{"agent-acp-service", "agent-controller", "skill-registry"} {
		digest := sha256.Sum256([]byte(acpIncarnationRPCToken(caller)))
		callers[caller] = []string{fmt.Sprintf("sha256:%x", digest)}
	}
	raw, err := json.Marshal(callers)
	if err != nil {
		t.Fatal("encode component caller fixture failed")
	}
	receiver, err := serviceauth.ParseReceiver("runtime-controller", raw, false)
	if err != nil {
		t.Fatal("construct real component workload receiver failed")
	}
	return rpc.Security{Authentication: receiver}
}

func acpIncarnationRPCOutbound(t *testing.T) serviceauth.LookupEnv {
	t.Helper()
	directory := t.TempDir()
	callers := filepath.Join(directory, "callers.json")
	for path, content := range map[string]string{callers: "{}", filepath.Join(directory, "agent-acp-service"): acpIncarnationRPCToken("probe-peer")} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal("write private component workload fixture failed")
		}
	}
	values := map[string]string{
		"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": directory,
	}
	return func(key string) (string, bool) { value, present := values[key]; return value, present }
}

type acpIncarnationRPCResponse struct {
	status int
	raw    []byte
	fields map[string]json.RawMessage
}

func acpIncarnationRPCCall(t *testing.T, parent context.Context, client *http.Client, origin, method, path string, input any, caller string) acpIncarnationRPCResponse {
	t.Helper()
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal("encode component HTTP request failed")
		}
		body = bytes.NewReader(raw)
	}
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, origin+path, body)
	if err != nil {
		t.Fatal("construct component HTTP request failed")
	}
	request.Header.Set("Content-Type", "application/json")
	if caller != "" {
		request.Header.Set(serviceauth.Header, "Bearer "+acpIncarnationRPCToken(caller))
	}
	response, err := client.Do(request)
	if err != nil {
		if response != nil && response.Body != nil {
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Error("close failed component HTTP response failed")
			}
		}
		t.Fatal("actual component HTTP request failed")
	}
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8193))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || len(raw) > 8192 || response.Header.Get("Content-Type") != "application/json" || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("component response did not completely read and close within its private wire boundary")
	}
	result := acpIncarnationRPCResponse{status: response.StatusCode, raw: raw}
	if serviceauth.DecodeObject(raw, &result.fields) != nil {
		t.Fatal("component response was not a strict JSON object")
	}
	return result
}

func (r acpIncarnationRPCResponse) decode(t *testing.T, status int, target any) {
	t.Helper()
	if r.status != status {
		t.Fatalf("component HTTP status=%d: unexpected response status", r.status)
	}
	var err error
	if _, inspection := target.(*acpincarnation.Inspection); inspection {
		// Preserve strict object validation without asking exactFields to treat
		// time.Time's JSON string as a struct. The domain decode then checks dates.
		var wire struct {
			State          string  `json:"state"`
			RegistrationID string  `json:"registration_id"`
			MemberID       string  `json:"member_id"`
			IncarnationID  string  `json:"incarnation_id"`
			Reason         string  `json:"reason"`
			ObservedAt     *string `json:"observed_at"`
			StopReceipt    *struct {
				ReceiptID  string `json:"receipt_id"`
				Reason     string `json:"reason"`
				ObservedAt string `json:"observed_at"`
			} `json:"stop_receipt"`
		}
		err = serviceauth.DecodeObject(r.raw, &wire)
		if err == nil {
			err = json.Unmarshal(r.raw, target)
		}
	} else {
		err = serviceauth.DecodeObject(r.raw, target)
	}
	if err != nil {
		t.Fatalf("component HTTP status=%d: strict response decode failed", r.status)
	}
}

func (r acpIncarnationRPCResponse) assertFailure(t *testing.T, status int, code string) {
	t.Helper()
	var failure struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	}
	r.decode(t, status, &failure)
	if len(r.fields) != 3 || failure.Code != code || failure.Retryable || failure.Message == "" {
		t.Fatal("workload denial lost its strict nonretryable error contract")
	}
}

func (r acpIncarnationRPCResponse) assertUnknown(t *testing.T, registrationID, reason string) {
	t.Helper()
	var value acpincarnation.Inspection
	r.decode(t, http.StatusOK, &value)
	if len(r.fields) != 3 || value.State != "unknown" || value.Reason != reason || value.RegistrationID != registrationID || value.MemberID != "" || value.IncarnationID != "" || value.StopReceipt != nil || value.ObservedAt != nil {
		t.Fatal("unknown inspection became a stop fact or disclosed a process identity")
	}
}

type acpIncarnationRPCServer struct {
	server      *httptest.Server
	handlers    atomic.Int32
	connections atomic.Int32
	once        sync.Once
}

func acpIncarnationRPCStartServer(t *testing.T, handler http.Handler) *acpIncarnationRPCServer {
	t.Helper()
	fixture := &acpIncarnationRPCServer{}
	fixture.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.handlers.Add(1)
		defer fixture.handlers.Add(-1)
		handler.ServeHTTP(w, r)
	}))
	fixture.server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			fixture.connections.Add(1)
		} else if state == http.StateClosed {
			fixture.connections.Add(-1)
		}
	}
	fixture.server.Start()
	t.Cleanup(func() { fixture.close(t) })
	return fixture
}

func (s *acpIncarnationRPCServer) close(t *testing.T) {
	t.Helper()
	s.once.Do(func() {
		s.server.CloseClientConnections()
		s.server.Close()
		if s.handlers.Load() != 0 || s.connections.Load() != 0 {
			t.Error("owning-service component did not actually join its HTTP server and connections")
		}
	})
}

func acpIncarnationRPCWriteFixture(w http.ResponseWriter, status int, value any, failures *atomic.Int32) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		failures.Add(1)
	}
}

type acpIncarnationRPCTransport struct {
	*http.Transport
	calls  atomic.Int32
	active atomic.Int32
	bodies atomic.Int32
}

func acpIncarnationRPCNewTransport(t *testing.T) *acpIncarnationRPCTransport {
	t.Helper()
	transport := &acpIncarnationRPCTransport{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	t.Cleanup(transport.CloseIdleConnections)
	return transport
}

func (t *acpIncarnationRPCTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	t.calls.Add(1)
	t.active.Add(1)
	defer t.active.Add(-1)
	response, err := t.Transport.RoundTrip(request)
	if response != nil && response.Body != nil {
		t.bodies.Add(1)
		response.Body = &acpIncarnationRPCBody{ReadCloser: response.Body, pending: &t.bodies}
	}
	return response, err
}

type acpIncarnationRPCBody struct {
	io.ReadCloser
	pending *atomic.Int32
	once    sync.Once
}

func (b *acpIncarnationRPCBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(func() { b.pending.Add(-1) })
	return err
}
