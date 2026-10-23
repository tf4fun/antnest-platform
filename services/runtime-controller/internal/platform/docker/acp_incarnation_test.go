package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

const acpIncarnationContainerID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const acpIncarnationStartedAt = "2026-10-23T09:15:16.123456789Z"
const acpIncarnationNetwork = "acp-owner-network"
const acpIncarnationSelector = "configured-acp-member"

func TestAcpIncarnationPlatformRequiresClient(t *testing.T) {
	if _, err := NewAcpIncarnationPlatform(nil); err == nil {
		t.Fatal("accepted a missing Docker client")
	}
}

func TestAcpIncarnationPlatformEngineID(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"valid with unrelated Docker fields", 200, `{"ID":"engine-original","Containers":7,"Driver":"overlay2"}`, "engine-original"},
		{"missing", 200, `{}`, ""},
		{"empty", 200, `{"ID":""}`, ""},
		{"whitespace", 200, `{"ID":" \t\r\n"}`, ""},
		{"null", 200, `{"ID":null}`, ""},
		{"wrong type", 200, `{"ID":17}`, ""},
		{"non-200 success status", 201, `{"ID":"engine-original"}`, ""},
		{"empty success status", 204, ``, ""},
		{"not found is not container absence", 404, `{"message":"missing info"}`, ""},
		{"failed status", 500, `{"message":"unavailable"}`, ""},
		{"malformed", 200, `{"ID":`, ""},
		{"second JSON value", 200, `{"ID":"engine-original"} {"ID":"replacement"}`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			adapter := acpIncarnationHTTPFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				acpIncarnationRequireRequest(t, w, r, "/v1.47/info")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			got, err := adapter.EngineID(t.Context())
			if test.want != "" {
				if err != nil || got != test.want {
					t.Fatalf("EngineID = %q, %v; want original engine identity", got, err)
				}
			} else if err == nil {
				t.Fatalf("accepted invalid engine response: %q", got)
			}
			if errors.Is(err, acpincarnation.ErrContainerNotFound) {
				t.Fatal("engine failure became positive container-absence evidence")
			}
		})
	}
}

func TestAcpIncarnationPlatformInspectUsesExactDockerFacts(t *testing.T) {
	for _, test := range []struct {
		name    string
		running bool
		address string
	}{
		{"running on selected network", true, "10.31.0.8"},
		{"stopped with retained address", false, "10.31.0.8"},
		{"stopped without address", false, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := acpIncarnationInspectBody()
			body["State"].(map[string]any)["Running"] = test.running
			body["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)[acpIncarnationNetwork] = map[string]any{"IPAddress": test.address}
			adapter := acpIncarnationHTTPFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				acpIncarnationRequireRequest(t, w, r, acpIncarnationInspectPath(acpIncarnationSelector))
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(body); err != nil {
					t.Errorf("write Docker fixture: %v", err)
				}
			}))
			got, err := adapter.Inspect(t.Context(), acpIncarnationSelector, acpIncarnationNetwork)
			want := acpincarnation.Observation{ContainerID: acpIncarnationContainerID, StartedAt: acpIncarnationStartedAt, Address: test.address, Running: test.running}
			if err != nil || got != want {
				t.Fatalf("Inspect = %+v, %v; want %+v", got, err, want)
			}
		})
	}
}

func TestAcpIncarnationPlatformRejectsInvalidInspectFacts(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missing Id cannot use Name", func(v map[string]any) { delete(v, "Id"); v["Name"] = acpIncarnationContainerID }},
		{"short Id", func(v map[string]any) { v["Id"] = "short-id" }},
		{"uppercase Id", func(v map[string]any) { v["Id"] = strings.Repeat("A", 64) }},
		{"nonhex Id", func(v map[string]any) { v["Id"] = strings.Repeat("g", 64) }},
		{"missing Running", func(v map[string]any) { delete(v["State"].(map[string]any), "Running") }},
		{"null Running", func(v map[string]any) { v["State"].(map[string]any)["Running"] = nil }},
		{"string Running", func(v map[string]any) { v["State"].(map[string]any)["Running"] = "false" }},
		{"missing StartedAt cannot use RestartCount", func(v map[string]any) { delete(v["State"].(map[string]any), "StartedAt"); v["RestartCount"] = 123 }},
		{"empty StartedAt", func(v map[string]any) { v["State"].(map[string]any)["StartedAt"] = "" }},
		{"invalid calendar date", func(v map[string]any) { v["State"].(map[string]any)["StartedAt"] = "2026-02-30T09:15:16Z" }},
		{"invalid time", func(v map[string]any) { v["State"].(map[string]any)["StartedAt"] = "not-a-start-time" }},
		{"hostname cannot become address", func(v map[string]any) {
			v["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)[acpIncarnationNetwork] = map[string]any{"IPAddress": "other-acp.internal"}
		}},
		{"URL cannot become address", func(v map[string]any) {
			v["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)[acpIncarnationNetwork] = map[string]any{"IPAddress": "http://10.31.0.8:8082"}
		}},
		{"address is not trimmed", func(v map[string]any) {
			v["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)[acpIncarnationNetwork] = map[string]any{"IPAddress": " 10.31.0.8 "}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := acpIncarnationInspectBody()
			test.mutate(body)
			adapter := acpIncarnationHTTPFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				acpIncarnationRequireRequest(t, w, r, acpIncarnationInspectPath(acpIncarnationSelector))
				if err := json.NewEncoder(w).Encode(body); err != nil {
					t.Errorf("write Docker fixture: %v", err)
				}
			}))
			if _, err := adapter.Inspect(t.Context(), acpIncarnationSelector, acpIncarnationNetwork); err == nil || errors.Is(err, acpincarnation.ErrContainerNotFound) {
				t.Fatalf("invalid facts became a valid observation or absence: %v", err)
			}
		})
	}
}

func TestAcpIncarnationPlatformMissingAddressDoesNotBorrowAnotherNetwork(t *testing.T) {
	for _, missingNetwork := range []bool{false, true} {
		body := acpIncarnationInspectBody()
		networks := body["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)
		if missingNetwork {
			delete(networks, acpIncarnationNetwork)
		} else {
			networks[acpIncarnationNetwork] = map[string]any{}
		}
		adapter := acpIncarnationHTTPFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if err := json.NewEncoder(w).Encode(body); err != nil {
				t.Errorf("write Docker fixture: %v", err)
			}
		}))
		observed, err := adapter.Inspect(t.Context(), acpIncarnationSelector, acpIncarnationNetwork)
		if err != nil || observed.Address != "" || observed.ContainerID != acpIncarnationContainerID || !observed.Running {
			t.Fatalf("missing probe address changed process facts or borrowed another network: %+v, %v", observed, err)
		}
	}
}

func TestAcpIncarnationPlatformContainerAbsenceRequiresExactCompleted404(t *testing.T) {
	valid, err := json.Marshal(acpIncarnationInspectBody())
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		status  int
		body    string
		missing bool
	}{
		{"container 404", 404, `{"message":"No such container"}`, true},
		{"server failure", 500, `{"message":"failed"}`, false},
		{"malformed success", 200, `{"Id":`, false},
		{"second JSON value", 200, string(valid) + ` {"Id":"another"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			adapter := acpIncarnationHTTPFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				acpIncarnationRequireRequest(t, w, r, acpIncarnationInspectPath(acpIncarnationSelector))
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			_, err := adapter.Inspect(t.Context(), acpIncarnationSelector, acpIncarnationNetwork)
			if err == nil || errors.Is(err, acpincarnation.ErrContainerNotFound) != test.missing {
				t.Fatalf("container error = %v; absence = %v", err, test.missing)
			}
		})
	}
	t.Run("transport failure", func(t *testing.T) {
		failure := errors.New("owned Docker transport failed")
		client, err := NewHTTPClient(&http.Client{Transport: acpIncarnationRoundTrip(func(*http.Request) (*http.Response, error) { return nil, failure })}, "http://docker")
		if err != nil {
			t.Fatal(err)
		}
		adapter, err := NewAcpIncarnationPlatform(client)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := adapter.Inspect(t.Context(), acpIncarnationSelector, acpIncarnationNetwork); err == nil || errors.Is(err, acpincarnation.ErrContainerNotFound) {
			t.Fatalf("transport failure became absence: %v", err)
		}
	})
}

func TestAcpIncarnationPlatformRejectsIncompleteAndUnclosedBodies(t *testing.T) {
	valid, err := json.Marshal(acpIncarnationInspectBody())
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		engine bool
		status int
		body   string
		short  bool
	}{
		{"engine read failure", true, 200, `{"ID":"engine-original"}`, true},
		{"inspect read failure", false, 200, string(valid), true},
		{"404 read failure", false, 404, `{"message":"missing"}`, true},
		{"engine close failure", true, 200, `{"ID":"engine-original"}`, false},
		{"inspect close failure", false, 200, string(valid), false},
		{"404 close failure", false, 404, `{"message":"missing"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			closed := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				path := acpIncarnationInspectPath(acpIncarnationSelector)
				if test.engine {
					path = "/v1.47/info"
				}
				acpIncarnationRequireRequest(t, w, r, path)
				if test.short {
					w.Header().Set("Content-Length", "16384")
				}
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			httpClient := server.Client()
			underlying := httpClient.Transport
			if underlying == nil {
				underlying = http.DefaultTransport
			}
			httpClient.Transport = acpIncarnationRoundTrip(func(request *http.Request) (*http.Response, error) {
				response, err := underlying.RoundTrip(request)
				if err == nil {
					var closeErr error
					if !test.short {
						closeErr = errors.New("owned response close failed")
					}
					response.Body = &acpIncarnationBodyReceipt{ReadCloser: response.Body, closed: closed, closeErr: closeErr}
				}
				return response, err
			})
			t.Cleanup(func() { httpClient.CloseIdleConnections(); server.CloseClientConnections(); server.Close() })
			client, err := NewHTTPClient(httpClient, server.URL)
			if err != nil {
				t.Fatal(err)
			}
			adapter, err := NewAcpIncarnationPlatform(client)
			if err != nil {
				t.Fatal(err)
			}
			if test.engine {
				_, err = adapter.EngineID(t.Context())
			} else {
				_, err = adapter.Inspect(t.Context(), acpIncarnationSelector, acpIncarnationNetwork)
			}
			acpIncarnationWait(t, closed, "response Body.Close")
			if err == nil || errors.Is(err, acpincarnation.ErrContainerNotFound) {
				t.Fatalf("failed body was accepted as complete observation/absence: %v", err)
			}
		})
	}
}

func TestAcpIncarnationPlatformNeverFollowsRedirects(t *testing.T) {
	for _, engine := range []bool{true, false} {
		t.Run(map[bool]string{true: "engine", false: "container"}[engine], func(t *testing.T) {
			var targetRequests atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				targetRequests.Add(1)
				w.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(w, `{"ID":"redirected-engine"}`)
			}))
			t.Cleanup(target.Close)
			adapter := acpIncarnationHTTPFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, target.URL+"/unexpected", http.StatusTemporaryRedirect)
			}))
			var err error
			if engine {
				_, err = adapter.EngineID(t.Context())
			} else {
				_, err = adapter.Inspect(t.Context(), acpIncarnationSelector, acpIncarnationNetwork)
			}
			if err == nil || errors.Is(err, acpincarnation.ErrContainerNotFound) || targetRequests.Load() != 0 {
				t.Fatalf("redirect was followed or became absence: target requests=%d err=%v", targetRequests.Load(), err)
			}
		})
	}
}

func TestAcpIncarnationPlatformCancellationJoinsHeldBody(t *testing.T) {
	for _, test := range []struct {
		name   string
		engine bool
		status int
	}{
		{"engine response", true, 200},
		{"container response", false, 200},
		{"container 404 response", false, 404},
	} {
		t.Run(test.name, func(t *testing.T) {
			entered, handlerDone := make(chan struct{}), make(chan struct{})
			requestCancelled, bodyClosed := make(chan struct{}), make(chan struct{})
			responseReceived := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			ctx, cancel := context.WithCancel(t.Context())
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				path := acpIncarnationInspectPath(acpIncarnationSelector)
				if test.engine {
					path = "/v1.47/info"
				}
				acpIncarnationRequireRequest(t, w, r, path)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, `{"pending":`)
				w.(http.Flusher).Flush()
				close(entered)
				select {
				case <-r.Context().Done():
					close(requestCancelled)
				case <-release:
				}
			}))
			httpClient := server.Client()
			underlying := httpClient.Transport
			if underlying == nil {
				underlying = http.DefaultTransport
			}
			httpClient.Transport = acpIncarnationRoundTrip(func(request *http.Request) (*http.Response, error) {
				response, err := underlying.RoundTrip(request)
				if err == nil {
					response.Body = &acpIncarnationBodyReceipt{ReadCloser: response.Body, closed: bodyClosed}
					close(responseReceived)
				}
				return response, err
			})
			returned := make(chan struct{})
			var launched bool
			var callErr error
			t.Cleanup(func() {
				cancel()
				releaseOnce.Do(func() { close(release) })
				server.CloseClientConnections()
				if launched {
					select {
					case <-returned:
					case <-time.After(3 * time.Second):
						t.Error("original adapter call did not join after fixture release")
					}
				}
				httpClient.CloseIdleConnections()
				server.Close()
			})
			client, err := NewHTTPClient(httpClient, server.URL)
			if err != nil {
				t.Fatal(err)
			}
			adapter, err := NewAcpIncarnationPlatform(client)
			if err != nil {
				t.Fatal(err)
			}
			launched = true
			go func() {
				defer close(returned)
				if test.engine {
					_, callErr = adapter.EngineID(ctx)
				} else {
					_, callErr = adapter.Inspect(ctx, acpIncarnationSelector, acpIncarnationNetwork)
				}
			}()
			select {
			case <-entered:
			case <-returned:
				t.Fatalf("adapter returned before held response: %v", callErr)
			case <-time.After(3 * time.Second):
				t.Fatal("Docker response was not entered")
			}
			acpIncarnationWait(t, responseReceived, "client received held response body")
			cancel()
			acpIncarnationWait(t, returned, "cancelled adapter call")
			acpIncarnationWait(t, requestCancelled, "server observed request cancellation")
			acpIncarnationWait(t, bodyClosed, "cancelled response Body.Close")
			releaseOnce.Do(func() { close(release) })
			server.CloseClientConnections()
			server.Close()
			acpIncarnationWait(t, handlerDone, "original server handler")
			if callErr == nil || errors.Is(callErr, acpincarnation.ErrContainerNotFound) {
				t.Fatalf("cancelled body became successful observation/absence: %v", callErr)
			}
		})
	}
}

func acpIncarnationHTTPFixture(t *testing.T, handler http.Handler) *AcpIncarnationPlatform {
	t.Helper()
	server := httptest.NewServer(handler)
	httpClient := server.Client()
	httpClient.Timeout = 3 * time.Second
	t.Cleanup(func() { httpClient.CloseIdleConnections(); server.CloseClientConnections(); server.Close() })
	client, err := NewHTTPClient(httpClient, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := NewAcpIncarnationPlatform(client)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func acpIncarnationInspectBody() map[string]any {
	return map[string]any{
		"Id": acpIncarnationContainerID, "Name": "/this-name-is-not-the-process-identity", "RestartCount": 42,
		"State": map[string]any{"Running": true, "StartedAt": acpIncarnationStartedAt, "Status": "running", "Health": map[string]any{"Status": "starting"}},
		"NetworkSettings": map[string]any{"Networks": map[string]any{
			acpIncarnationNetwork: map[string]any{"IPAddress": "10.31.0.8", "NetworkID": "network-name-is-not-an-address"},
			"another-network":     map[string]any{"IPAddress": "10.99.0.9"},
		}},
		"Config": map[string]any{"Labels": map[string]string{"unrelated": "normal-Docker-field"}},
		"Mounts": []any{},
	}
}

func acpIncarnationInspectPath(selector string) string {
	return "/v1.47/containers/" + url.PathEscape(selector) + "/json"
}

func acpIncarnationRequireRequest(t *testing.T, w http.ResponseWriter, r *http.Request, path string) {
	t.Helper()
	if r.Method != http.MethodGet || r.URL.EscapedPath() != path || r.URL.RawQuery != "" {
		t.Errorf("unexpected Docker request: %s %s", r.Method, r.URL.RequestURI())
		http.Error(w, "unexpected Docker fixture route", http.StatusBadRequest)
	}
}

func acpIncarnationWait(t *testing.T, done <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("did not join %s", label)
	}
}

type acpIncarnationRoundTrip func(*http.Request) (*http.Response, error)

func (f acpIncarnationRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type acpIncarnationBodyReceipt struct {
	io.ReadCloser
	closed   chan struct{}
	closeErr error
	once     sync.Once
}

func (b *acpIncarnationBodyReceipt) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(func() { close(b.closed) })
	return errors.Join(err, b.closeErr)
}
