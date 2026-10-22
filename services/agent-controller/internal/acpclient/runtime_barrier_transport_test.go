package acpclient_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/temporal"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const runtimeBarrierTransportValidResult = `{"organization_id":"org1","agent_id":"agent1","runtime_revision":"runtime1","barrier":null}`

func runtimeBarrierTransportQuery() ports.RuntimeBarrierQuery {
	return ports.RuntimeBarrierQuery{OrganizationID: "org1", AgentID: "agent1", ExpectedRuntimeRevision: "runtime1"}
}

func runtimeBarrierTransportPrivate(t *testing.T, err error, secrets ...string) {
	t.Helper()
	require.Error(t, err)
	pending := []error{err}
	for visited := 0; len(pending) > 0; visited++ {
		require.Less(t, visited, 64, "error causes must be bounded")
		cause := pending[0]
		pending = pending[1:]
		if cause == nil {
			continue
		}
		for _, secret := range secrets {
			require.NotContains(t, cause.Error(), secret)
		}
		switch nested := cause.(type) {
		case interface{ Unwrap() []error }:
			pending = append(pending, nested.Unwrap()...)
		case interface{ Unwrap() error }:
			pending = append(pending, nested.Unwrap())
		}
	}
	failure := temporal.GetDefaultFailureConverter().ErrorToFailure(err)
	payload, encodeErr := protojson.Marshal(failure)
	require.NoError(t, encodeErr)
	for _, secret := range secrets {
		require.NotContains(t, string(payload), secret)
	}
}

func TestRuntimeBarrierTransportMapsOnlyMatchingErrorsWithoutRetry(t *testing.T) {
	for _, test := range []struct {
		name            string
		status          int
		remoteCode      string
		remoteRetryable bool
		code            string
		retryable       bool
	}{
		{"invalid request", 400, "invalid_request", false, "invalid_request", false},
		{"not found", 404, "not_found", false, "not_found", false},
		{"revision conflict", 409, "configuration_conflict", false, "configuration_conflict", false},
		{"configuration cold", 503, "configuration_not_ready", true, "configuration_not_ready", true},
		{"storage unavailable", 503, "execution_state_unavailable", true, "execution_state_unavailable", true},
		{"not found at 400", 400, "not_found", false, "invalid_response", true},
		{"invalid request at 404", 404, "invalid_request", false, "invalid_response", true},
		{"not found at 409", 409, "not_found", false, "invalid_response", true},
		{"conflict at 503", 503, "configuration_conflict", false, "invalid_response", true},
		{"configuration cold at 500", 500, "configuration_not_ready", true, "invalid_response", true},
		{"error returned as success", 200, "execution_state_unavailable", true, "invalid_response", true},
		{"unknown client error", 422, "unknown-private-code", false, "invalid_response", true},
		{"unknown server error", 500, "unknown-private-code", true, "dependency_unavailable", true},
		{"unknown unavailable error", 503, "unknown-private-code", true, "dependency_unavailable", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			body := fmt.Sprintf(`{"code":%q,"message":"runtime-barrier-private-response","retryable":%t}`, test.remoteCode, test.remoteRetryable)
			client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				require.Empty(t, request.Header.Get("Antnest-Caller-Context"))
				writeResponse(t, writer, test.status, body)
			})
			result, err := client.GetRuntimeBarrier(t.Context(), runtimeBarrierTransportQuery())
			assertFailure(t, err, test.code, test.retryable)
			require.Equal(t, ports.RuntimeBarrierResult{}, result, "failure must not become a successful null barrier")
			runtimeBarrierTransportPrivate(t, err, "runtime-barrier-private-response", "unknown-private-code")
			require.Equal(t, int32(1), calls.Load(), "the query client must not retry")
		})
	}
}

func TestRuntimeBarrierTransportDoesNotFollowRedirects(t *testing.T) {
	for _, status := range []int{http.StatusMovedPermanently, http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var originCalls, destinationCalls atomic.Int32
			destination := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				destinationCalls.Add(1)
				writeResponse(t, writer, http.StatusOK, runtimeBarrierTransportValidResult)
			}))
			t.Cleanup(destination.Close)
			client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
				originCalls.Add(1)
				http.Redirect(writer, request, destination.URL+"/private-redirect-body", status)
			})
			result, err := client.GetRuntimeBarrier(t.Context(), runtimeBarrierTransportQuery())
			assertFailure(t, err, "invalid_response", true)
			require.Equal(t, ports.RuntimeBarrierResult{}, result)
			require.Equal(t, int32(1), originCalls.Load())
			require.Zero(t, destinationCalls.Load())
			runtimeBarrierTransportPrivate(t, err, destination.URL, "private-redirect-body")
		})
	}
}

type runtimeBarrierTransportBody struct {
	reader       io.Reader
	readErr      error
	closeErr     error
	reads        atomic.Int32
	closes       atomic.Int32
	closeEntered chan struct{}
	closeRelease <-chan struct{}
	closeDone    chan struct{}
}

func (body *runtimeBarrierTransportBody) Read(value []byte) (int, error) {
	body.reads.Add(1)
	if body.readErr != nil {
		return 0, body.readErr
	}
	return body.reader.Read(value)
}

func (body *runtimeBarrierTransportBody) Close() error {
	if body.closes.Add(1) != 1 {
		return errors.New("runtime barrier response body closed more than once")
	}
	if body.closeDone != nil {
		defer close(body.closeDone)
	}
	if body.closeEntered != nil {
		close(body.closeEntered)
	}
	if body.closeRelease != nil {
		<-body.closeRelease
	}
	return body.closeErr
}

func TestRuntimeBarrierTransportSanitizesTransportReadAndCloseFailures(t *testing.T) {
	const endpoint = "http://runtime-barrier-private-endpoint.invalid"
	const cct = "runtime-barrier-private-cct"
	const credential = "runtime-barrier-private-workload-credential"
	const privateBody = "runtime-barrier-private-body"
	secretFailure := errors.New(endpoint + " " + cct + " " + credential + " " + privateBody)
	for _, phase := range []string{"transport", "read", "close", "read and close"} {
		t.Run(phase, func(t *testing.T) {
			var calls atomic.Int32
			body := &runtimeBarrierTransportBody{reader: strings.NewReader(runtimeBarrierTransportValidResult)}
			transport := transportFunc(func(request *http.Request) (*http.Response, error) {
				calls.Add(1)
				require.Empty(t, request.Header.Get("Antnest-Caller-Context"))
				request.Header.Set("Antnest-Service-Authorization", credential)
				_, readErr := io.ReadAll(request.Body)
				require.NoError(t, readErr)
				require.NoError(t, request.Body.Close())
				if phase == "transport" {
					return nil, secretFailure
				}
				if phase == "read" || phase == "read and close" {
					body.readErr = errors.Join(secretFailure, io.ErrUnexpectedEOF)
				}
				if phase == "close" || phase == "read and close" {
					body.closeErr = secretFailure
				}
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: body}, nil
			})
			client, err := acpclient.New(endpoint, time.Second, &http.Client{Transport: transport})
			require.NoError(t, err)
			result, err := client.GetRuntimeBarrier(t.Context(), runtimeBarrierTransportQuery())
			code := "invalid_response"
			if phase == "transport" {
				code = "dependency_unavailable"
			} else {
				require.Positive(t, body.reads.Load())
				require.Equal(t, int32(1), body.closes.Load(), "the actual response body must be closed even after read failure")
			}
			assertFailure(t, err, code, true)
			require.Equal(t, ports.RuntimeBarrierResult{}, result)
			if phase == "read" || phase == "read and close" {
				require.ErrorIs(t, err, io.ErrUnexpectedEOF)
			}
			runtimeBarrierTransportPrivate(t, err, endpoint, cct, credential, privateBody)
			require.Equal(t, int32(1), calls.Load())
		})
	}
}

type runtimeBarrierTransportCall struct {
	result ports.RuntimeBarrierResult
	err    error
}

func TestRuntimeBarrierTransportJoinsHeldBodyCloseBeforeReturning(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var releaseOnce sync.Once
		unblock := func() { releaseOnce.Do(func() { close(release) }) }
		body := &runtimeBarrierTransportBody{
			reader:       strings.NewReader(runtimeBarrierTransportValidResult),
			closeErr:     errors.New("runtime-barrier-held-close-private"),
			closeEntered: make(chan struct{}), closeRelease: release, closeDone: make(chan struct{}),
		}
		var calls atomic.Int32
		transport := transportFunc(func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			if err := request.Body.Close(); err != nil {
				return nil, err
			}
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: body}, nil
		})
		client, err := acpclient.New("http://runtime-barrier.internal", time.Hour, &http.Client{Transport: transport})
		require.NoError(t, err)
		finished := make(chan runtimeBarrierTransportCall, 1)
		joined := false
		go func() {
			result, err := client.GetRuntimeBarrier(t.Context(), runtimeBarrierTransportQuery())
			finished <- runtimeBarrierTransportCall{result, err}
		}()
		defer func() {
			unblock()
			if !joined {
				<-finished
			}
		}()
		select {
		case <-body.closeEntered:
		case <-finished:
			joined = true
			t.Fatal("query returned without entering actual response body Close")
		}
		synctest.Wait()
		select {
		case <-finished:
			joined = true
			t.Fatal("query returned before held response body Close settled")
		default:
		}
		select {
		case <-body.closeDone:
			t.Fatal("response body Close settled before release")
		default:
		}
		unblock()
		outcome := <-finished
		joined = true
		<-body.closeDone
		assertFailure(t, outcome.err, "invalid_response", true)
		require.Equal(t, ports.RuntimeBarrierResult{}, outcome.result)
		require.Equal(t, int32(1), body.closes.Load())
		require.Equal(t, int32(1), calls.Load())
		runtimeBarrierTransportPrivate(t, outcome.err, "runtime-barrier-held-close-private")
	})
}

func TestRuntimeBarrierTransportCancelledSuccessfulCloseCannotReturnNullBarrier(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var releaseOnce sync.Once
		unblock := func() { releaseOnce.Do(func() { close(release) }) }
		body := &runtimeBarrierTransportBody{
			reader:       strings.NewReader(runtimeBarrierTransportValidResult),
			closeEntered: make(chan struct{}), closeRelease: release, closeDone: make(chan struct{}),
		}
		var calls atomic.Int32
		transport := transportFunc(func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			if err := request.Body.Close(); err != nil {
				return nil, err
			}
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: body}, nil
		})
		client, err := acpclient.New("http://runtime-barrier.internal", time.Hour, &http.Client{Transport: transport})
		require.NoError(t, err)
		ctx, cancel := context.WithCancel(t.Context())
		finished := make(chan runtimeBarrierTransportCall, 1)
		joined := false
		go func() {
			result, err := client.GetRuntimeBarrier(ctx, runtimeBarrierTransportQuery())
			finished <- runtimeBarrierTransportCall{result, err}
		}()
		defer func() {
			cancel()
			unblock()
			if !joined {
				<-finished
			}
		}()
		select {
		case <-body.closeEntered:
		case <-finished:
			joined = true
			t.Fatal("query returned without entering actual response body Close")
		}
		cancel()
		synctest.Wait()
		select {
		case <-finished:
			joined = true
			t.Fatal("cancelled query returned before successful body Close actually settled")
		default:
		}
		select {
		case <-body.closeDone:
			t.Fatal("successful body Close settled without its release")
		default:
		}
		unblock()
		outcome := <-finished
		joined = true
		<-body.closeDone
		require.Equal(t, int32(1), body.closes.Load())
		require.Equal(t, int32(1), calls.Load())
		require.ErrorIs(t, outcome.err, context.Canceled)
		require.Equal(t, ports.RuntimeBarrierResult{}, outcome.result, "cancellation after body read must not become a successful null barrier")
		runtimeBarrierTransportPrivate(t, outcome.err, "http://runtime-barrier.internal")
	})
}

type runtimeBarrierTransportPartialBody struct {
	io.ReadCloser
	received chan struct{}
	once     sync.Once
}

func (body *runtimeBarrierTransportPartialBody) Read(value []byte) (int, error) {
	n, err := body.ReadCloser.Read(value)
	if n > 0 {
		body.once.Do(func() { close(body.received) })
	}
	return n, err
}

func runtimeBarrierTransportAwait(t *testing.T, channel <-chan struct{}, boundary string) {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-channel:
	case <-timer.C:
		t.Fatalf("runtime barrier transport did not reach %s", boundary)
	}
}

func TestRuntimeBarrierTransportNativeCancellationAndTimeoutJoinConnections(t *testing.T) {
	for _, test := range []struct {
		name         string
		timeout      time.Duration
		cancelParent bool
		partialBody  bool
		want         error
	}{
		{"parent cancellation while waiting for headers", 5 * time.Second, true, false, context.Canceled},
		{"client timeout while waiting for headers", time.Second, false, false, context.DeadlineExceeded},
		{"parent cancellation while reading a partial body", 5 * time.Second, true, true, context.Canceled},
		{"client timeout while reading a partial body", time.Second, false, true, context.DeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			entered, disconnected, connectionsClosed := make(chan struct{}), make(chan struct{}), make(chan struct{})
			partialBodyReceived := make(chan struct{})
			fallback := make(chan struct{})
			var enteredOnce, disconnectedOnce, closedOnce, fallbackOnce sync.Once
			var calls, activeHandlers, activeConnections atomic.Int32
			var handlers sync.WaitGroup
			var handlerErrorsMu sync.Mutex
			var handlerErrors []error
			handlerError := func(err error) {
				handlerErrorsMu.Lock()
				defer handlerErrorsMu.Unlock()
				handlerErrors = append(handlerErrors, err)
			}
			const workload = "runtime-barrier-native-workload-private"
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				activeHandlers.Add(1)
				handlers.Add(1)
				defer func() { activeHandlers.Add(-1); handlers.Done() }()
				_, readErr := io.ReadAll(request.Body)
				closeErr := request.Body.Close()
				if readErr != nil || closeErr != nil {
					handlerError(errors.Join(readErr, closeErr))
					return
				}
				if request.Method != http.MethodPost || request.URL.Path != "/rpc/agent-acp/get-runtime-barrier" || request.Header.Get("Antnest-Service-Authorization") != workload || request.Header.Get("Antnest-Caller-Context") != "" {
					handlerError(errors.New("native query did not preserve the workload-only transport boundary"))
					return
				}
				if test.partialBody {
					writer.Header().Set("Content-Type", "application/json")
					writer.WriteHeader(http.StatusOK)
					if _, err := io.WriteString(writer, `{"organization_id":"org1","agent_id":"agent1","runtime_revision":"runtime1","barrier":`); err != nil {
						handlerError(err)
						return
					}
					if err := http.NewResponseController(writer).Flush(); err != nil {
						handlerError(err)
						return
					}
				}
				enteredOnce.Do(func() { close(entered) })
				select {
				case <-request.Context().Done():
					disconnectedOnce.Do(func() { close(disconnected) })
				case <-fallback:
					// Only failed-test cleanup may release this boundary.
				}
			}))
			server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
				switch state {
				case http.StateNew:
					activeConnections.Add(1)
				case http.StateClosed, http.StateHijacked:
					if activeConnections.Add(-1) == 0 {
						closedOnce.Do(func() { close(connectionsClosed) })
					}
				}
			}
			server.Start()
			transport := &http.Transport{Proxy: nil}
			workloadTransport := transportFunc(func(request *http.Request) (*http.Response, error) {
				forwarded := request.Clone(request.Context())
				forwarded.Header.Set("Antnest-Service-Authorization", workload)
				response, err := transport.RoundTrip(forwarded)
				if test.partialBody && response != nil && response.Body != nil {
					response.Body = &runtimeBarrierTransportPartialBody{ReadCloser: response.Body, received: partialBodyReceived}
				}
				return response, err
			})
			ctx, cancel := context.WithCancel(context.Background())
			finished := make(chan runtimeBarrierTransportCall, 1)
			started, joined := false, false
			defer func() {
				cancel()
				fallbackOnce.Do(func() { close(fallback) })
				transport.CloseIdleConnections()
				server.CloseClientConnections()
				server.Close()
				handlers.Wait()
				if started && !joined {
					<-finished
				}
				transport.CloseIdleConnections()
				require.Zero(t, activeHandlers.Load())
				require.Zero(t, activeConnections.Load())
			}()
			client, err := acpclient.New(server.URL, test.timeout, &http.Client{Transport: workloadTransport})
			require.NoError(t, err)
			started = true
			go func() {
				result, err := client.GetRuntimeBarrier(ctx, runtimeBarrierTransportQuery())
				finished <- runtimeBarrierTransportCall{result, err}
			}()
			runtimeBarrierTransportAwait(t, entered, "the actual TCP handler")
			if test.partialBody {
				runtimeBarrierTransportAwait(t, partialBodyReceived, "the actual flushed response body read")
			}
			require.Equal(t, int32(1), activeHandlers.Load())
			if test.cancelParent {
				cancel()
			}
			timer := time.NewTimer(5 * time.Second)
			defer timer.Stop()
			var outcome runtimeBarrierTransportCall
			select {
			case outcome = <-finished:
				joined = true
			case <-timer.C:
				t.Fatal("native runtime barrier query did not settle")
			}
			// Prove remote cancellation before fallback release or server shutdown.
			runtimeBarrierTransportAwait(t, disconnected, "the server-side request disconnect")
			handlers.Wait()
			runtimeBarrierTransportAwait(t, connectionsClosed, "the actual TCP connection close")
			require.Zero(t, activeHandlers.Load())
			require.Zero(t, activeConnections.Load())
			require.Equal(t, int32(1), calls.Load(), "cancellation must not trigger a retry")
			require.ErrorIs(t, outcome.err, test.want)
			require.Equal(t, ports.RuntimeBarrierResult{}, outcome.result)
			runtimeBarrierTransportPrivate(t, outcome.err, server.URL, workload)
			handlerErrorsMu.Lock()
			observedErrors := errors.Join(handlerErrors...)
			handlerErrorsMu.Unlock()
			require.NoError(t, observedErrors)
		})
	}
}

func TestRuntimeBarrierTransportPrecancelledContextDoesNotCallDependency(t *testing.T) {
	var calls atomic.Int32
	client, err := acpclient.New("http://runtime-barrier.internal", time.Second, &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("pre-cancelled query invoked transport")
	})})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := client.GetRuntimeBarrier(ctx, runtimeBarrierTransportQuery())
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, ports.RuntimeBarrierResult{}, result)
	require.Zero(t, calls.Load())
}
