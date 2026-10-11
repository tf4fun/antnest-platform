package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

type observedBrowserConn struct {
	net.Conn
	probe *browserWriteProbe
}

func (conn *observedBrowserConn) SetWriteDeadline(deadline time.Time) error {
	err := conn.Conn.SetWriteDeadline(deadline)
	if err == nil {
		conn.probe.recordDeadline(deadline)
	}
	return err
}

func (conn *observedBrowserConn) Write(data []byte) (int, error) {
	conn.probe.active.Add(1)
	defer func() { conn.probe.completed.Add(1); conn.probe.active.Add(-1) }()
	return conn.Conn.Write(data)
}

type observedBrowserListener struct {
	net.Listener
	probe *browserWriteProbe
}

func (listener *observedBrowserListener) Accept() (net.Conn, error) {
	conn, err := listener.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if err := conn.(*net.TCPConn).SetWriteBuffer(1024); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &observedBrowserConn{Conn: conn, probe: listener.probe}, nil
}

func TestBrowserWebSocketRevocationInterruptsBothBlockedDirections(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		for _, direction := range []string{"upstream-to-browser", "browser-to-upstream"} {
			t.Run(version+"/"+direction, func(t *testing.T) {
				service := newStreamIdentity()
				service.principal.ActivityIntervalMS = 500
				start, release := make(chan struct{}), make(chan struct{})
				var startOnce sync.Once
				begin := func() { startOnce.Do(func() { close(start) }) }
				peerReady := make(chan *websocket.Conn, 1)
				peerDone := make(chan struct{})
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					defer close(peerDone)
					upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
					conn, err := upgrader.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer func() { _ = conn.Close() }()
					if err := conn.UnderlyingConn().(*net.TCPConn).SetReadBuffer(1024); err != nil {
						t.Error(err)
					}
					peerReady <- conn
					<-start
					if direction == "upstream-to-browser" {
						if conn.WriteMessage(websocket.BinaryMessage, []byte(strings.Repeat("x", 4<<20))) == nil {
							_, _, _ = conn.ReadMessage()
						}
					} else {
						<-release
					}
				}))
				defer upstream.Close()
				h := newTestHandler(t, service, http.NotFoundHandler(), time.Now()).(*handler)
				h.maximumSessionStale = blockedBrowserSessionStale
				// The ordinary write deadline must not make a broken cancellation
				// path pass the shorter session-revocation deadline.
				h.requestTimeout = 2 * blockedBrowserSessionStale
				var err error
				h.agentACPURL, err = parseServiceURL(upstream.URL)
				if err != nil {
					t.Fatal(err)
				}
				browserProbe, upstreamProbe := &browserWriteProbe{}, &browserWriteProbe{}
				transport := http.DefaultTransport.(*http.Transport).Clone()
				defer transport.CloseIdleConnections()
				transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
					conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
					if err != nil {
						return nil, err
					}
					if err := conn.(*net.TCPConn).SetWriteBuffer(1024); err != nil {
						_ = conn.Close()
						return nil, err
					}
					return &observedBrowserConn{Conn: conn, probe: upstreamProbe}, nil
				}
				h.httpClient.Transport = transport
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				handlerDone := make(chan struct{})
				edge := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { defer close(handlerDone); h.ServeHTTP(w, r) }))
				edge.Config.BaseContext = func(net.Listener) context.Context { return ctx }
				edge.Listener = &observedBrowserListener{Listener: edge.Listener, probe: browserProbe}
				edge.Start()
				defer edge.Close()
				client, _, err := websocket.DefaultDialer.Dial(strings.Replace(edge.URL, "http://", "ws://", 1)+"/api/app/agents/agent-1/"+version+"/acp", http.Header{
					"Origin": {edge.URL}, "Cookie": {session.AccessTokenCookieName + "=token; " + session.CSRFCookieName + "=" + testCSRFToken},
				})
				if err != nil {
					begin()
					close(release)
					cancel()
					t.Fatal(err)
				}
				peer := <-peerReady
				var sendDone chan struct{}
				defer func() {
					cancel()
					begin()
					close(release)
					_ = client.Close()
					_ = peer.Close()
					<-handlerDone
					<-peerDone
					if sendDone != nil {
						<-sendDone
					}
				}()
				if err := client.UnderlyingConn().(*net.TCPConn).SetReadBuffer(1024); err != nil {
					t.Fatal(err)
				}
				begin()
				probe := browserProbe
				if direction == "browser-to-upstream" {
					probe = upstreamProbe
					sendDone = make(chan struct{})
					go func() {
						defer close(sendDone)
						_ = client.WriteMessage(websocket.BinaryMessage, []byte(strings.Repeat("x", 4<<20)))
					}()
				}
				awaitBlockedBrowserWrite(t, probe, handlerDone)
				deadline := time.Now().Add(blockedBrowserSessionStale)
				probe.requireCancellationBeforeWriteTimeout(t, deadline)
				service.mu.Lock()
				service.failure = &identity.RemoteError{Code: "unauthenticated"}
				service.mu.Unlock()
				select {
				case <-handlerDone:
				case <-time.After(time.Until(deadline)):
					t.Fatal("WebSocket session cancellation failed to close blocked sockets and join relays")
				}
				if time.Now().After(deadline) || browserProbe.active.Load() != 0 || upstreamProbe.active.Load() != 0 {
					t.Fatal("WebSocket handler left a writer behind")
				}
			})
		}
	}
}
