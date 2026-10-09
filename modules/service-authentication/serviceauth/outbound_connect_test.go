package serviceauth

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestOutboundConnectGivesUpBeforeTheRequestDeadline(t *testing.T) {
	originalDial, originalTimeout := dialDependency, dependencyConnectTimeout
	defer func() { dialDependency, dependencyConnectTimeout = originalDial, originalTimeout }()
	dependencyConnectTimeout = 50 * time.Millisecond
	dialed := make(chan string, 2)
	// An absent peer on a private network drops SYNs: the connect never answers.
	dialDependency = func(ctx context.Context, _, address string) (net.Conn, error) {
		dialed <- address
		<-ctx.Done()
		return nil, ctx.Err()
	}
	token := testToken(t)
	env := outboundEnvironment(t, "identity-service", token)
	clients, err := LoadOutbound("edge-gateway", GatewayHeaders, lookupEnvironment(env), map[string]string{"identity-service": "http://identity-service:8080"})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	for _, socket := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://identity-service:8080/v1/session", nil)
		if err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		var response *http.Response
		if socket {
			transport, socketErr := clients.SocketConfig("identity-service", req.Header)
			if socketErr != nil {
				t.Fatal(socketErr)
			}
			response, err = transport.RoundTrip(req)
		} else {
			response, err = clients.HTTPClient().Do(req)
		}
		requestExpired := ctx.Err() != nil
		cancel()
		if response != nil {
			_ = response.Body.Close()
		}
		if !errors.Is(err, context.DeadlineExceeded) || requestExpired {
			t.Fatalf("unanswered connect was not bounded by the dependency connect timeout: %v", err)
		}
		if elapsed := time.Since(started); elapsed > 5*time.Second {
			t.Fatalf("unanswered connect took %s", elapsed)
		}
		if address := <-dialed; address != "identity-service:8080" {
			t.Fatalf("dialed %q", address)
		}
	}
}

func TestOutboundConnectTimeoutIsShorterThanTheDefault(t *testing.T) {
	if dependencyConnectTimeout <= 0 || dependencyConnectTimeout > 5*time.Second {
		t.Fatalf("dependency connect timeout %s must report an absent peer within seconds", dependencyConnectTimeout)
	}
}
