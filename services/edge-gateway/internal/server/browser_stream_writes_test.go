package server

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentacp"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

type browserWriteProbe struct {
	http.ResponseWriter
	active    atomic.Int32
	completed atomic.Int64
}

func (probe *browserWriteProbe) Unwrap() http.ResponseWriter { return probe.ResponseWriter }

func (probe *browserWriteProbe) Write(data []byte) (int, error) {
	probe.active.Add(1)
	defer func() { probe.completed.Add(1); probe.active.Add(-1) }()
	return probe.ResponseWriter.Write(data)
}

func (probe *browserWriteProbe) FlushError() error {
	probe.active.Add(1)
	defer func() { probe.completed.Add(1); probe.active.Add(-1) }()
	return http.NewResponseController(probe.ResponseWriter).Flush()
}

func awaitBlockedBrowserWrite(t *testing.T, probe *browserWriteProbe) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		before := probe.completed.Load()
		active := probe.active.Load()
		time.Sleep(20 * time.Millisecond)
		if active > 0 && probe.active.Load() > 0 && probe.completed.Load() == before {
			return
		}
	}
	t.Fatal("fixture did not prove a blocked browser socket write")
}

func TestBrowserSessionCancellationInterruptsActualBlockedSSEWrites(t *testing.T) {
	for _, route := range browserSSERoutes {
		for _, reason := range []string{"live-revocation", "private-feed"} {
			t.Run(route.path+"/"+reason, func(t *testing.T) {
				service := newStreamIdentity()
				upstream := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.Copy(w, strings.NewReader(strings.Repeat("data: payload\n\n", 1<<19)))
				})
				execution := &executionServiceStub{watchState: func(ctx context.Context, emit agentacp.WorkspaceStateEmitter) error {
					for ctx.Err() == nil {
						if err := emit(agentacp.WorkspaceState{AgentID: "agent-1", Availability: "available", AccessAllowed: true}); err != nil {
							return err
						}
					}
					return ctx.Err()
				}}
				h := newTestHandlerWithServices(t, service, &agentServiceStub{}, execution, upstream, time.Now(), Config{}).(*handler)
				h.maximumSessionStale = 300 * time.Millisecond
				h.requestTimeout = 2 * time.Second
				probeReady := make(chan *browserWriteProbe, 1)
				handlerDone := make(chan struct{})
				edge := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					defer close(handlerDone)
					probe := &browserWriteProbe{ResponseWriter: w}
					probeReady <- probe
					h.ServeHTTP(probe, r)
				}))
				edge.Config.ConnContext = func(ctx context.Context, conn net.Conn) context.Context {
					if tcp, ok := conn.(*net.TCPConn); ok {
						if err := tcp.SetWriteBuffer(1024); err != nil {
							t.Error(err)
						}
					}
					return ctx
				}
				edge.Start()
				defer edge.Close()
				client, err := net.Dial("tcp", edge.Listener.Addr().String())
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = client.Close(); edge.Close() }()
				if err := client.(*net.TCPConn).SetReadBuffer(1024); err != nil {
					t.Fatal(err)
				}
				_, err = fmt.Fprintf(client, "GET %s HTTP/1.1\r\nHost: %s\r\nCookie: %s=token; %s=%s\r\n\r\n", route.path, edge.Listener.Addr(), session.AccessTokenCookieName, session.CSRFCookieName, testCSRFToken)
				if err != nil {
					t.Fatal(err)
				}
				var probe *browserWriteProbe
				select {
				case probe = <-probeReady:
				case <-time.After(time.Second):
					t.Fatal("request did not start")
				}
				awaitBlockedBrowserWrite(t, probe)
				started := time.Now()
				if reason == "private-feed" {
					p := service.principal
					h.browserStreams.Revoke(identity.SessionRevocation{TokenID: p.SessionID, UserID: p.UserID, OrganizationID: p.OrganizationID})
				} else {
					service.mu.Lock()
					service.failure = &identity.RemoteError{Code: "unauthenticated"}
					service.mu.Unlock()
				}
				select {
				case <-handlerDone:
				case <-time.After(400 * time.Millisecond):
					t.Fatal("session cancellation failed to interrupt blocked socket write")
				}
				if time.Since(started) > 400*time.Millisecond || probe.active.Load() != 0 {
					t.Fatal("handler returned before its blocked writes completed")
				}
			})
		}
	}
}
