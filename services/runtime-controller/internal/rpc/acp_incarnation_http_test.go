package rpc

import (
	"bufio"
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
	"syscall"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
)

func TestAcpIncarnationHTTPIncompleteBodiesRespectTotalDeadline(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		t.Run(fmt.Sprintf("chunked-%t", chunked), func(t *testing.T) {
			port := &incarnationHTTPPort{}
			handler := incarnationHTTPHandler(t, port, 200*time.Millisecond)
			fixture := incarnationHTTPStart(t, handler, nil)
			// The JSON itself is valid. Neither the advertised Content-Length nor
			// the chunked document is complete, so parsing a prefix is not admission.
			body := incarnationRPCJSON(t, incarnationRPCInput())
			started := time.Now()
			fixture.write(t, http.MethodPost, incarnationRPCRegisterPath, body, chunked, false)
			incarnationHTTPAwait(t, fixture.readEntered, "actual request body read")
			response := fixture.readResponse(t)
			incarnationHTTPAwait(t, fixture.returned, "bounded request handler")
			if time.Since(started) > 2*time.Second {
				t.Fatal("incomplete HTTP body outlived the shortened total request budget")
			}
			incarnationRPCError(t, response, http.StatusGatewayTimeout, "deadline_exceeded", true)
			if port.calls() != 0 || fixture.reading.Load() != 0 {
				t.Fatal("incomplete body reached a port or left its actual Read running")
			}
			fixture.awaitPeerClosed(t, false)
		})
	}
}

func TestAcpIncarnationHTTPFourKiBBoundaryOnTCP(t *testing.T) {
	valid := incarnationRPCJSON(t, incarnationRPCInput())
	for _, size := range []int{4096, 4097} {
		for _, chunked := range []bool{false, true} {
			t.Run(fmt.Sprintf("bytes-%d/chunked-%t", size, chunked), func(t *testing.T) {
				port := &incarnationHTTPPort{}
				handler := incarnationHTTPHandler(t, port, 250*time.Millisecond)
				fixture := incarnationHTTPStart(t, handler, nil)
				fixture.write(t, http.MethodPost, incarnationRPCRegisterPath, valid+strings.Repeat(" ", size-len(valid)), chunked, true)
				response := fixture.readResponse(t)
				incarnationHTTPAwait(t, fixture.returned, "complete request handler")
				if size == 4096 {
					if response.Code != http.StatusOK || port.registerCalls.Load() != 1 || port.inspectCalls.Load() != 0 {
						t.Fatal("real HTTP refused the exact four-KiB registration boundary")
					}
					value := incarnationRPCObject(t, response)
					if len(value) != 3 || value["registration_id"] != incarnationRPCRegistrationID || value["member_id"] != "acp-a" || value["incarnation_id"] != incarnationRPCID {
						t.Fatal("real HTTP changed the accepted registration receipt")
					}
				} else {
					incarnationRPCError(t, response, http.StatusRequestEntityTooLarge, "request_too_large", false)
					if port.calls() != 0 {
						t.Fatal("oversized real HTTP request reached a business port")
					}
				}
				if fixture.reading.Load() != 0 {
					t.Fatal("request handler returned before its actual body Read")
				}
				fixture.awaitPeerClosed(t, size > 4096)
			})
		}
	}
}

func TestAcpIncarnationHTTPDisconnectCancelsAndJoinsPortCleanup(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		t.Run(method, func(t *testing.T) {
			entered, portReturned, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			cancelObserved := make(chan error, 1)
			var releaseOnce sync.Once
			releasePort := func() { releaseOnce.Do(func() { close(release) }) }
			port := &incarnationHTTPPort{}
			work := func(ctx context.Context) {
				defer close(portReturned)
				close(entered)
				select {
				case <-ctx.Done():
					cancelObserved <- ctx.Err()
				case <-release:
				}
				// Cancellation is observed, but this represents actual owned port
				// cleanup that has not returned yet. No background race is a join.
				<-release
			}
			port.register = func(ctx context.Context, _ acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
				work(ctx)
				return incarnationRPCRegistration(), nil
			}
			port.inspect = func(ctx context.Context, id string) (acpincarnation.Inspection, error) {
				work(ctx)
				return acpincarnation.Inspection{State: "unknown", RegistrationID: id, Reason: "unregistered"}, nil
			}
			defer func() {
				releasePort()
				if port.calls() != 0 {
					incarnationHTTPAwait(t, portReturned, "released original port callback")
				}
			}()
			var earlyReturn atomic.Bool
			handler := incarnationHTTPHandler(t, port, 2*time.Second)
			fixture := incarnationHTTPStart(t, handler, func() {
				select {
				case <-portReturned:
				default:
					earlyReturn.Store(true)
				}
			})
			path, body := incarnationRPCInspectPath, ""
			if method == http.MethodPost {
				path, body = incarnationRPCRegisterPath, incarnationRPCJSON(t, incarnationRPCInput())
			}
			fixture.write(t, method, path, body, false, true)
			incarnationHTTPAwait(t, entered, "original port callback")
			fixture.closeClient(t)
			select {
			case err := <-cancelObserved:
				if !errors.Is(err, context.Canceled) {
					t.Fatal("client disconnect was replaced by a later handler deadline")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("real client disconnect did not cancel the original port context")
			}
			select {
			case <-portReturned:
				t.Fatal("fixture port cleanup did not remain held")
			default:
			}
			select {
			case <-fixture.returned:
				t.Fatal("HTTP handler returned before its cancelled port cleanup")
			default:
			}
			releasePort()
			incarnationHTTPAwait(t, portReturned, "original port cleanup")
			incarnationHTTPAwait(t, fixture.returned, "original handler after cleanup")
			incarnationHTTPAwait(t, fixture.closed, "server connection after client disconnect")
			if earlyReturn.Load() || port.calls() != 1 || fixture.reading.Load() != 0 {
				t.Fatal("disconnect detached port work, dispatched again, or retained an actual body Read")
			}
		})
	}
}

func TestAcpIncarnationHTTPLateSuccessAfterDeadlineIsRejected(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		t.Run(method, func(t *testing.T) {
			port := &incarnationHTTPPort{}
			returned := make(chan struct{})
			observed := make(chan error, 1)
			release := make(chan struct{})
			var releaseOnce sync.Once
			releasePort := func() { releaseOnce.Do(func() { close(release) }) }
			work := func(ctx context.Context) {
				defer close(returned)
				select {
				case <-ctx.Done():
					observed <- ctx.Err()
				case <-release:
					// Failsafe cleanup never supplies deadline evidence.
				}
			}
			port.register = func(ctx context.Context, _ acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
				work(ctx)
				return incarnationRPCRegistration(), nil
			}
			port.inspect = func(ctx context.Context, id string) (acpincarnation.Inspection, error) {
				work(ctx)
				return acpincarnation.Inspection{State: "unknown", RegistrationID: id, Reason: "unregistered"}, nil
			}
			handler := incarnationHTTPHandler(t, port, 150*time.Millisecond)
			path, body := incarnationRPCInspectPath, ""
			if method == http.MethodPost {
				path, body = incarnationRPCRegisterPath, incarnationRPCJSON(t, incarnationRPCInput())
			}
			request := incarnationRPCRequest(method, path, body, "agent-acp-service")
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			response := httptest.NewRecorder()
			handlerReturned := make(chan struct{})
			defer func() {
				cancel()
				releasePort()
				incarnationHTTPAwait(t, handlerReturned, "original late-success handler cleanup")
				if port.calls() != 0 {
					incarnationHTTPAwait(t, returned, "original late-success port cleanup")
				}
			}()
			started := time.Now()
			go func() {
				defer close(handlerReturned)
				handler.ServeHTTP(response, request.WithContext(ctx))
			}()
			select {
			case <-handlerReturned:
			case <-time.After(2 * time.Second):
				cancel()
				releasePort()
				// Release the real callback and join the original invocation before
				// reporting failure, even if production discarded its context.
				incarnationHTTPAwait(t, handlerReturned, "released late-success handler")
				if port.calls() != 0 {
					incarnationHTTPAwait(t, returned, "released late-success port")
				}
				t.Fatal("accepted port required failsafe release after losing its request deadline")
			}
			if time.Since(started) > 2*time.Second {
				t.Fatal("accepted port ignored the shortened total handler deadline")
			}
			incarnationHTTPAwait(t, returned, "late successful port callback")
			select {
			case err := <-observed:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("port did not observe the actual request deadline")
				}
			default:
				t.Fatal("handler returned without the original port deadline observation")
			}
			incarnationRPCError(t, response, http.StatusGatewayTimeout, "deadline_exceeded", true)
			if port.calls() != 1 || strings.Contains(response.Body.String(), incarnationRPCRegistrationID) {
				t.Fatal("late success escaped as a receipt or caused another dispatch")
			}
		})
	}
}

type incarnationHTTPPort struct {
	registerCalls atomic.Int32
	inspectCalls  atomic.Int32
	register      func(context.Context, acpincarnation.RegisterRequest) (acpincarnation.Registration, error)
	inspect       func(context.Context, string) (acpincarnation.Inspection, error)
}

var _ AcpIncarnationService = (*incarnationHTTPPort)(nil)

func (p *incarnationHTTPPort) Register(ctx context.Context, input acpincarnation.RegisterRequest) (acpincarnation.Registration, error) {
	p.registerCalls.Add(1)
	if p.register != nil {
		return p.register(ctx, input)
	}
	return incarnationRPCRegistration(), nil
}

func (p *incarnationHTTPPort) Inspect(ctx context.Context, id string) (acpincarnation.Inspection, error) {
	p.inspectCalls.Add(1)
	if p.inspect != nil {
		return p.inspect(ctx, id)
	}
	return acpincarnation.Inspection{State: "unknown", RegistrationID: id, Reason: "unregistered"}, nil
}

func (p *incarnationHTTPPort) calls() int32 {
	return p.registerCalls.Load() + p.inspectCalls.Load()
}

func incarnationHTTPHandler(t *testing.T, port AcpIncarnationService, timeout time.Duration) *Handler {
	t.Helper()
	handler, err := NewHandlerWithAcpIncarnations(&fakeService{}, observation.NewHub(), time.Second, timeout, incarnationRPCSecurity(t), port, &preparationStub{})
	if err != nil {
		t.Fatal("construct real incarnation HTTP handler failed")
	}
	return handler
}

type incarnationHTTPFixture struct {
	server      *httptest.Server
	connection  net.Conn
	returned    chan struct{}
	closed      chan struct{}
	readEntered chan struct{}
	reading     atomic.Int32
	connections atomic.Int32
	readOnce    sync.Once
	closeOnce   sync.Once
}

type incarnationHTTPBody struct {
	io.ReadCloser
	fixture *incarnationHTTPFixture
}

func (b *incarnationHTTPBody) Read(buffer []byte) (int, error) {
	b.fixture.reading.Add(1)
	defer b.fixture.reading.Add(-1)
	b.fixture.readOnce.Do(func() { close(b.fixture.readEntered) })
	return b.ReadCloser.Read(buffer)
}

func incarnationHTTPStart(t *testing.T, handler http.Handler, onReturn func()) *incarnationHTTPFixture {
	t.Helper()
	fixture := &incarnationHTTPFixture{returned: make(chan struct{}), closed: make(chan struct{}), readEntered: make(chan struct{})}
	var closedOnce sync.Once
	fixture.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(fixture.returned)
		if onReturn != nil {
			defer onReturn()
		}
		r.Body = &incarnationHTTPBody{ReadCloser: r.Body, fixture: fixture}
		handler.ServeHTTP(w, r)
	}))
	fixture.server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			fixture.connections.Add(1)
		}
		if state == http.StateClosed {
			fixture.connections.Add(-1)
			closedOnce.Do(func() { close(fixture.closed) })
		}
	}
	fixture.server.Start()
	t.Cleanup(func() {
		// Fallback cleanup happens only after the behavioral assertions. It
		// cannot turn an unbounded original handler into a passing observation.
		fixture.closeClient(t)
		fixture.server.CloseClientConnections()
		fixture.server.Close()
		if fixture.connection != nil {
			incarnationHTTPAwait(t, fixture.closed, "owned server connection cleanup")
		}
		if fixture.reading.Load() != 0 || fixture.connections.Load() != 0 {
			t.Error("real HTTP fixture left a body Read or server connection running")
		}
	})
	connection, err := net.DialTimeout("tcp", fixture.server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal("connect owned incarnation HTTP fixture failed")
	}
	fixture.connection = connection
	return fixture
}

func (f *incarnationHTTPFixture) closeClient(t *testing.T) {
	t.Helper()
	f.closeOnce.Do(func() {
		if f.connection != nil {
			if err := f.connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error("close owned incarnation HTTP client failed")
			}
		}
	})
}

func (f *incarnationHTTPFixture) write(t *testing.T, method, path, body string, chunked, complete bool) {
	t.Helper()
	if err := f.connection.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal("set owned HTTP write deadline failed")
	}
	header := fmt.Sprintf("%s %s HTTP/1.1\r\nHost: runtime-controller.invalid\r\n%s: Bearer %s\r\nContent-Type: application/json\r\nConnection: close\r\n", method, path, serviceauth.Header, incarnationRPCToken("agent-acp-service"))
	wireBody := body
	if chunked {
		header += "Transfer-Encoding: chunked\r\n\r\n"
		wireBody = fmt.Sprintf("%x\r\n%s\r\n", len(body), body)
		if complete {
			wireBody += "0\r\n\r\n"
		}
	} else {
		length := len(body)
		if !complete {
			length = 4096
		}
		header += fmt.Sprintf("Content-Length: %d\r\n\r\n", length)
	}
	wire := header + wireBody
	written, err := io.WriteString(f.connection, wire)
	if err != nil || written != len(wire) {
		t.Fatal("write complete owned HTTP request prefix failed")
	}
}

func (f *incarnationHTTPFixture) readResponse(t *testing.T) *httptest.ResponseRecorder {
	t.Helper()
	if err := f.connection.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal("set owned HTTP read deadline failed")
	}
	response, err := http.ReadResponse(bufio.NewReader(f.connection), nil)
	if err != nil {
		t.Fatalf("real HTTP did not return a complete response before the fixture deadline: %v", err)
	}
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8193))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || len(raw) > 8192 {
		t.Fatal("real HTTP response body did not complete and close within its wire limit")
	}
	recorder := httptest.NewRecorder()
	for key, values := range response.Header {
		recorder.Header()[key] = append([]string(nil), values...)
	}
	recorder.WriteHeader(response.StatusCode)
	if _, err := recorder.Write(raw); err != nil {
		t.Fatal("retain actual HTTP response for closed-wire assertions failed")
	}
	return recorder
}

func (f *incarnationHTTPFixture) awaitPeerClosed(t *testing.T, rejectedBody bool) {
	t.Helper()
	var extra [1]byte
	// A complete 413 can be followed by TCP reset when rejected request bytes
	// remain unread. Both outcomes still require the original StateClosed event.
	if n, err := f.connection.Read(extra[:]); n != 0 || !(errors.Is(err, io.EOF) || rejectedBody && errors.Is(err, syscall.ECONNRESET)) {
		t.Fatalf("server did not actually close its completed HTTP connection: bytes=%d error=%v", n, err)
	}
	incarnationHTTPAwait(t, f.closed, "completed server TCP connection")
	if f.connections.Load() != 0 {
		t.Fatal("completed HTTP request retained its server connection")
	}
}

func incarnationHTTPAwait(t *testing.T, done <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("did not actually join %s", name)
	}
}
