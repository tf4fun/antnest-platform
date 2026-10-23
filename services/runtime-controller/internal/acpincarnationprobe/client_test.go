package acpincarnationprobe

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

const probeTestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const probeTestPath = "/internal/acp-owner/incarnation/probe"

func TestProbeUsesInspectedAddressAndExactAuthenticatedWire(t *testing.T) {
	request := probeTestRequest()
	var calls atomic.Int32
	server := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, port, err := net.SplitHostPort(r.Context().Value(http.LocalAddrContextKey).(net.Addr).String())
		if err != nil {
			t.Error("probe fixture has no local port")
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if !probeAssertRequest(t, r, net.JoinHostPort("acp-owner.invalid", port), request) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		probeWriteJSON(t, w, request)
	}))
	member, observation := probeTestTarget(t, server.URL)
	client := probeTestClient(t)
	originalMember, originalObservation := member, observation
	got, err := client.Probe(t.Context(), member, observation, request)
	if err != nil || got != request || calls.Load() != 1 {
		t.Fatalf("probe did not preserve the exact echo or single dispatch: calls=%d err=%v", calls.Load(), err)
	}
	if member != originalMember || observation != originalObservation {
		t.Fatal("probe mutated its inspected target")
	}
}

func TestProbeIgnoresProxyAndNeverFallsBackToDNS(t *testing.T) {
	request := probeTestRequest()
	var targetCalls, proxyCalls, dnsCalls atomic.Int32
	proxy := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { proxyCalls.Add(1); w.WriteHeader(http.StatusBadGateway) }))
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	originalTransport, originalResolver := http.DefaultTransport, net.DefaultResolver
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyURL(proxyURL)
	http.DefaultTransport = transport
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		dnsCalls.Add(1)
		return nil, errors.New("unexpected probe DNS lookup")
	}}
	t.Cleanup(func() {
		http.DefaultTransport = originalTransport
		net.DefaultResolver = originalResolver
		transport.CloseIdleConnections()
	})
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("ALL_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	server := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { targetCalls.Add(1); probeWriteJSON(t, w, request) }))
	member, observation := probeTestTarget(t, server.URL)
	client := probeTestClient(t)
	if got, err := client.Probe(t.Context(), member, observation, request); err != nil || got != request {
		t.Fatalf("inspected literal address was not used: %v", err)
	}
	for _, address := range []string{"", "localhost", "acp-owner.invalid", "http://127.0.0.1", "127.0.0.2"} {
		changed := observation
		changed.Address = address
		_, err := client.Probe(t.Context(), member, changed, request)
		probeAssertSafeError(t, err, request)
	}
	if targetCalls.Load() != 1 || proxyCalls.Load() != 0 || dnsCalls.Load() != 0 {
		t.Fatalf("probe escaped the inspected destination: target=%d proxy=%d dns=%d", targetCalls.Load(), proxyCalls.Load(), dnsCalls.Load())
	}
}

func TestProbeRejectsRedirectWithoutContactingTarget(t *testing.T) {
	request := probeTestRequest()
	var sourceCalls, targetCalls atomic.Int32
	target := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { targetCalls.Add(1); probeWriteJSON(t, w, request) }))
	server := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sourceCalls.Add(1)
		http.Redirect(w, r, target.URL+"/steal", http.StatusTemporaryRedirect)
	}))
	member, observation := probeTestTarget(t, server.URL)
	_, err := probeTestClient(t).Probe(t.Context(), member, observation, request)
	probeAssertSafeError(t, err, request)
	if sourceCalls.Load() != 1 || targetCalls.Load() != 0 {
		t.Fatalf("redirect/retry dispatched another request: source=%d target=%d", sourceCalls.Load(), targetCalls.Load())
	}
}

func TestProbeRejectsInvalidReplyWithoutRetry(t *testing.T) {
	request := probeTestRequest()
	valid := probeJSON(t, request)
	tests := []struct {
		name        string
		status      int
		media, body string
		short       bool
	}{
		{"created is not success", 201, "application/json", valid, false},
		{"empty status is not success", 204, "application/json", "", false},
		{"refused intent", 409, "application/json", `{"message":"` + request.RegistrationNonce + `"}`, false},
		{"server failure", 500, "application/json", `{"message":"` + request.Challenge + `"}`, false},
		{"non JSON media", 200, "text/plain", valid, false},
		{"malformed JSON", 200, "application/json", `{"member_id":`, false},
		{"null", 200, "application/json", `null`, false},
		{"array", 200, "application/json", `[]`, false},
		{"multiple JSON values", 200, "application/json", valid + ` {}`, false},
		{"decoded duplicate key", 200, "application/json", strings.Replace(valid, `"member_id":`, `"member_id":"member-a","\u006dember_id":`, 1), false},
		{"case alias", 200, "application/json", strings.Replace(valid, `"member_id":`, `"Member_id":`, 1), false},
		{"unknown field", 200, "application/json", strings.TrimSuffix(valid, "}") + `,"private":true}`, false},
		{"wrong field type", 200, "application/json", strings.Replace(valid, `"member_id":"member-a"`, `"member_id":7`, 1), false},
		{"read failure after complete JSON", 200, "application/json", valid, true},
	}
	fields := []struct{ name, other string }{
		{"member_id", "member-b"},
		{"incarnation_id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"},
		{"registration_nonce", strings.Repeat("c", 64)},
		{"challenge", strings.Repeat("d", 64)},
	}
	for _, field := range fields {
		var missing map[string]any
		if err := json.Unmarshal([]byte(valid), &missing); err != nil {
			t.Fatal(err)
		}
		delete(missing, field.name)
		tests = append(tests, struct {
			name        string
			status      int
			media, body string
			short       bool
		}{"missing " + field.name, 200, "application/json", probeJSON(t, missing), false})
		missing[field.name] = field.other
		tests = append(tests, struct {
			name        string
			status      int
			media, body string
			short       bool
		}{"different " + field.name, 200, "application/json", probeJSON(t, missing), false})
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", test.media)
				if test.short {
					w.Header().Set("Content-Length", strconv.Itoa(len(test.body)+32))
				}
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			member, observation := probeTestTarget(t, server.URL)
			_, err := probeTestClient(t).Probe(t.Context(), member, observation, request)
			probeAssertSafeError(t, err, request)
			if calls.Load() != 1 {
				t.Fatalf("invalid reply caused %d dispatches", calls.Load())
			}
		})
	}
}

func TestProbeEnforcesReplyByteLimit(t *testing.T) {
	request := probeTestRequest()
	valid := probeJSON(t, request)
	for _, size := range []int{8192, 8193} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			server := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, valid+strings.Repeat(" ", size-len(valid)))
			}))
			member, observation := probeTestTarget(t, server.URL)
			got, err := probeTestClient(t).Probe(t.Context(), member, observation, request)
			if size == 8192 {
				if err != nil || got != request {
					t.Fatalf("valid bounded reply was rejected: %v", err)
				}
			} else {
				probeAssertSafeError(t, err, request)
			}
		})
	}
}

func TestProbeInvalidRequestDoesNotReachPeer(t *testing.T) {
	var calls atomic.Int32
	server := probeTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	member, observation := probeTestTarget(t, server.URL)
	client := probeTestClient(t)
	for _, field := range []string{"member", "incarnation", "nonce", "challenge", "oversize"} {
		request := probeTestRequest()
		switch field {
		case "member":
			request.MemberID = "other-member"
		case "incarnation":
			request.IncarnationID = "not-a-uuid"
		case "nonce":
			request.RegistrationNonce = "not-a-nonce"
		case "challenge":
			request.Challenge = "not-a-challenge"
		case "oversize":
			request.MemberID = strings.Repeat("a", 4097)
		}
		_, err := client.Probe(t.Context(), member, observation, request)
		probeAssertSafeError(t, err, request)
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid request reached peer %d times", calls.Load())
	}
}

func TestProbeChangesInspectedAddressWithoutReusingOldConnection(t *testing.T) {
	firstListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = firstListener.Close() })
	port := firstListener.Addr().(*net.TCPAddr).Port
	secondAddress := "127.0.0.2"
	secondListener, err := net.Listen("tcp4", net.JoinHostPort(secondAddress, strconv.Itoa(port)))
	if err != nil {
		secondAddress = "::1"
		secondListener, err = net.Listen("tcp6", net.JoinHostPort(secondAddress, strconv.Itoa(port)))
		if err != nil {
			t.Skip("second IPv4 and IPv6 loopback addresses unavailable; changed-address pool behavior unverified")
		}
	}
	t.Cleanup(func() { _ = secondListener.Close() })
	request := probeTestRequest()
	var firstCalls, secondCalls atomic.Int32
	first := probeTestServerAt(t, firstListener, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { firstCalls.Add(1); probeWriteJSON(t, w, request) }))
	_ = probeTestServerAt(t, secondListener, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { secondCalls.Add(1); probeWriteJSON(t, w, request) }))
	member, observation := probeTestTarget(t, first.URL)
	client := probeTestClient(t)
	if _, err := client.Probe(t.Context(), member, observation, request); err != nil {
		t.Fatal(err)
	}
	observation.Address = secondAddress
	observation.ContainerID = strings.Repeat("d", 64)
	observation.StartedAt = "2026-10-23T10:00:01Z"
	if _, err := client.Probe(t.Context(), member, observation, request); err != nil {
		t.Fatal(err)
	}
	if firstCalls.Load() != 1 || secondCalls.Load() != 1 {
		t.Fatalf("old pool selected the wrong process: first=%d second=%d", firstCalls.Load(), secondCalls.Load())
	}
}

func TestProbeJoinsCancelledAndDeadlineHeldBodies(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "parent cancellation", true: "client two-second deadline"}[deadline], func(t *testing.T) {
			request := probeTestRequest()
			entered, handlerDone, peerCancelled := make(chan struct{}), make(chan struct{}), make(chan struct{})
			firstResponseByte, release := make(chan struct{}), make(chan struct{})
			var responseOnce, releaseOnce sync.Once
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"member_id":`)
				w.(http.Flusher).Flush()
				close(entered)
				select {
				case <-r.Context().Done():
					close(peerCancelled)
				case <-release:
				}
			}))
			member, observation := probeTestTarget(t, server.URL)
			client := probeTestClient(t)
			ctx, cancel := context.WithCancel(t.Context())
			ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotFirstResponseByte: func() { responseOnce.Do(func() { close(firstResponseByte) }) }})
			returned := make(chan struct{})
			var callErr error
			var elapsed time.Duration
			var launched bool
			t.Cleanup(func() {
				cancel()
				releaseOnce.Do(func() { close(release) })
				server.CloseClientConnections()
				if launched {
					select {
					case <-returned:
					case <-time.After(3 * time.Second):
						t.Error("original Probe did not join after fixture release")
					}
				}
				server.Close()
			})
			launched = true
			started := time.Now()
			go func() {
				defer close(returned)
				_, callErr = client.Probe(ctx, member, observation, request)
				elapsed = time.Since(started)
			}()
			select {
			case <-entered:
			case <-returned:
				t.Fatalf("Probe failed before held HTTP body: %v", callErr)
			case <-time.After(3 * time.Second):
				t.Fatal("Probe did not enter HTTP response")
			}
			probeWait(t, firstResponseByte, "original response bytes")
			if !deadline {
				cancel()
			}
			probeWait(t, returned, "original Probe call")
			probeWait(t, peerCancelled, "peer observed request cancellation")
			releaseOnce.Do(func() { close(release) })
			server.CloseClientConnections()
			server.Close()
			probeWait(t, handlerDone, "original HTTP handler")
			probeAssertSafeError(t, callErr, request)
			want := context.Canceled
			if deadline {
				want = context.DeadlineExceeded
			}
			if !errors.Is(callErr, want) {
				t.Fatalf("lost cancellation/deadline identity: %v", callErr)
			}
			if elapsed > 2*time.Second {
				t.Fatalf("Probe exceeded its complete two-second budget: %s", elapsed)
			}
			if calls.Load() != 1 {
				t.Fatalf("held body caused %d dispatches", calls.Load())
			}
		})
	}
}

func probeTestClient(t *testing.T) *Client {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "callers.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "agent-acp-service"), []byte(probeTestToken), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"ANTNEST_SERVICE_AUTH_MODE":                     "token",
		"ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_CALLERS_FILE":             filepath.Join(directory, "callers.json"),
		"ANTNEST_SERVICE_AUTH_TOKEN_DIR":                directory,
	}
	lookup := serviceauth.LookupEnv(func(key string) (string, bool) { value, present := environment[key]; return value, present })
	client, err := New(lookup)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func probeTestTarget(t *testing.T, raw string) (acpincarnation.Member, acpincarnation.Observation) {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return acpincarnation.Member{ID: "member-a", Selector: "configured-member", Network: "owner-private", Origin: "http://" + net.JoinHostPort("acp-owner.invalid", parsed.Port())},
		acpincarnation.Observation{ContainerID: strings.Repeat("c", 64), StartedAt: "2026-10-23T10:00:00Z", Address: "127.0.0.1", Running: true}
}

func probeTestRequest() acpincarnation.ProbeRequest {
	return acpincarnation.ProbeRequest{MemberID: "member-a", IncarnationID: "11111111-2222-4333-8444-555555555555", RegistrationNonce: strings.Repeat("a", 64), Challenge: strings.Repeat("b", 64)}
}

func probeAssertRequest(t *testing.T, r *http.Request, host string, want acpincarnation.ProbeRequest) bool {
	t.Helper()
	if r.Method != http.MethodPost || r.URL.Path != probeTestPath || r.URL.RawQuery != "" || r.Host != host || r.Header.Get("Content-Type") != "application/json" {
		t.Error("wrong fixed probe method, path, Host or media")
		return false
	}
	if values := r.Header.Values(serviceauth.Header); len(values) != 1 || values[0] != "Bearer "+probeTestToken {
		t.Error("probe did not use the exact ACP workload credential")
		return false
	}
	for _, name := range []string{"Authorization", "Cookie", "Antnest-Caller-Context", "X-Antnest-Principal-ID"} {
		if r.Header.Get(name) != "" {
			t.Errorf("probe forwarded forbidden authority header %s", name)
			return false
		}
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(raw) > 4096 {
		t.Error("probe request body was not bounded and complete")
		return false
	}
	var object map[string]json.RawMessage
	var got acpincarnation.ProbeRequest
	if json.Unmarshal(raw, &object) != nil || len(object) != 4 || json.Unmarshal(raw, &got) != nil || got != want {
		t.Error("probe did not send exactly the original four fields")
		return false
	}
	return true
}

func probeAssertSafeError(t *testing.T, err error, request acpincarnation.ProbeRequest) {
	t.Helper()
	if err == nil {
		t.Fatal("accepted an invalid or incomplete probe")
	}
	for _, secret := range []string{request.RegistrationNonce, request.Challenge, probeTestToken} {
		if secret != "" && strings.Contains(err.Error(), secret) {
			t.Fatal("probe error disclosed private nonce or credential material")
		}
	}
}

func probeJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func probeWriteJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Error("could not write probe fixture response")
	}
}

func probeTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(func() { server.CloseClientConnections(); server.Close() })
	return server
}

func probeTestServerAt(t *testing.T, listener net.Listener, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	_ = server.Listener.Close()
	server.Listener = listener
	server.Start()
	t.Cleanup(func() { server.CloseClientConnections(); server.Close() })
	return server
}

func probeWait(t *testing.T, done <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("did not join %s", label)
	}
}
