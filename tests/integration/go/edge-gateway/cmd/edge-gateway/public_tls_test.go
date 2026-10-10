package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/config"
	"go.opentelemetry.io/otel"
)

func TestRunServesNativeTLSOnTheConfiguredListener(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	previousPropagation := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(previousPropagation) })
	directory := t.TempDir()
	writePublicTestCertificate(t, directory, 1)
	if err := os.WriteFile(filepath.Join(directory, "callers.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		"ANTNEST_EDGE_PUBLIC_ORIGIN":                    "https://antnest.example",
		"ANTNEST_EDGE_TLS_CERT_FILE":                    filepath.Join(directory, "cert.pem"),
		"ANTNEST_EDGE_TLS_KEY_FILE":                     filepath.Join(directory, "key.pem"),
		"ANTNEST_EDGE_TLS_CA_FILE":                      filepath.Join(directory, "ca.pem"),
		"ANTNEST_SERVICE_AUTH_MODE":                     "token",
		"ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_CALLERS_FILE":             filepath.Join(directory, "callers.json"),
		"ANTNEST_SERVICE_AUTH_TOKEN_DIR":                directory,
	}
	for variable, service := range map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "identity-service", "ANTNEST_ADMIN_CONSOLE_URL": "admin-console",
		"ANTNEST_AGENT_UI_URL": "agent-ui", "ANTNEST_AGENT_CONTROLLER_URL": "agent-controller", "ANTNEST_AGENT_ACP_URL": "agent-acp-service",
	} {
		values[variable] = "http://" + service + ":8080"
		token := make([]byte, 32)
		if _, err := rand.Read(token); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, service), []byte(fmt.Sprintf("%x", token)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	values["ANTNEST_EDGE_LISTEN"] = reservation.Addr().String()
	if err := reservation.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var runErr error
	go func() {
		defer close(done)
		runErr = run(ctx, func(name string) (string, bool) { value, present := values[name]; return value, present })
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
			if runErr != nil {
				t.Errorf("native Gateway failed: %v", runErr)
			}
		case <-time.After(5 * time.Second):
			t.Error("native Gateway did not stop")
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case <-done:
			t.Fatalf("native Gateway stopped before TLS health: %v", runErr)
		default:
		}
		if err := checkHealth(func(name string) string { return values[name] }); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("actual Gateway did not serve verified native HTTPS")
		}
		time.Sleep(time.Millisecond)
	}
	roots := x509.NewCertPool()
	roots.AddCert(publicTestCA(t, directory).Leaf)
	clientTLS := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: "antnest.example"}
	writePublicTestCertificate(t, directory, 2)
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for {
		peer, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", values["ANTNEST_EDGE_LISTEN"], clientTLS)
		if err != nil {
			t.Fatal(err)
		}
		serial := peer.ConnectionState().PeerCertificates[0].SerialNumber.Int64()
		_ = peer.Close()
		if serial == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("actual Gateway did not reload after SIGHUP")
		}
		time.Sleep(time.Millisecond)
	}
	secureClient := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil, TLSClientConfig: clientTLS}}
	defer secureClient.CloseIdleConnections()
	secureResponse, err := secureClient.Get("https://" + values["ANTNEST_EDGE_LISTEN"] + "/status")
	if err != nil {
		t.Fatal(err)
	}
	_ = secureResponse.Body.Close()
	if secureResponse.StatusCode != http.StatusOK || secureResponse.Header.Get("Strict-Transport-Security") != "max-age=31536000" {
		t.Fatal("actual native TLS response lost readiness or HSTS")
	}
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://" + values["ANTNEST_EDGE_LISTEN"] + "/status")
	if response != nil {
		defer func() { _ = response.Body.Close() }()
	}
	if err == nil && response.StatusCode == http.StatusOK {
		t.Fatal("native TLS listener also accepted cleartext HTTP")
	}
}

func writePublicTestCertificate(t *testing.T, directory string, serial int64, usage ...x509.ExtKeyUsage) tls.Certificate {
	t.Helper()
	issuer := publicTestCA(t, directory)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "antnest.example"},
		DNSNames: []string{"antnest.example"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if len(usage) > 0 {
		template.ExtKeyUsage = usage
	}
	der, err := x509.CreateCertificate(rand.Reader, template, issuer.Leaf, &key.PublicKey, issuer.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	for name, contents := range map[string][]byte{"cert.pem": certPEM, "key.pem": keyPEM} {
		if err := os.WriteFile(filepath.Join(directory, name+".next"), contents, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(filepath.Join(directory, name+".next"), filepath.Join(directory, name)); err != nil {
			t.Fatal(err)
		}
	}
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

func TestPublicTLSRejectsClientOnlyCertificateWithoutReplacingServer(t *testing.T) {
	directory := t.TempDir()
	writePublicTestCertificate(t, directory, 1)
	cfg := config.Config{PublicOrigin: "https://antnest.example", TLSCertFile: filepath.Join(directory, "cert.pem"), TLSKeyFile: filepath.Join(directory, "key.pem")}
	certificates, err := loadPublicTLS(cfg)
	if err != nil {
		t.Fatal(err)
	}
	writePublicTestCertificate(t, directory, 2, x509.ExtKeyUsageClientAuth)
	if err := certificates.reload(); err == nil {
		t.Fatal("client-only certificate replaced the working server certificate")
	}
	if certificates.certificate.Load().Leaf.SerialNumber.Int64() != 1 {
		t.Fatal("failed rotation changed the active certificate")
	}
	if _, err := loadPublicTLS(cfg); err == nil {
		t.Fatal("client-only certificate accepted on startup")
	}
}

func publicTestCA(t *testing.T, directory string) tls.Certificate {
	t.Helper()
	certFile, keyFile := filepath.Join(directory, "ca.pem"), filepath.Join(directory, "ca-key.pem")
	if _, err := os.Stat(certFile); os.IsNotExist(err) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		template := &x509.Certificate{SerialNumber: big.NewInt(100), Subject: pkix.Name{CommonName: "Disposable Gateway CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
		der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		keyDER, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
			t.Fatal(err)
		}
	}
	issuer, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	return issuer
}

func TestPublicTLSHealthVerifiesConfiguredCertificateAndHostname(t *testing.T) {
	directory := t.TempDir()
	certificate := writePublicTestCertificate(t, directory, 1)
	endpoint := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			t.Errorf("health path=%s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	endpoint.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}
	endpoint.StartTLS()
	t.Cleanup(endpoint.Close)
	values := map[string]string{
		"ANTNEST_EDGE_LISTEN":        endpoint.Listener.Addr().String(),
		"ANTNEST_EDGE_PUBLIC_ORIGIN": "https://antnest.example",
		"ANTNEST_EDGE_TLS_CERT_FILE": filepath.Join(directory, "cert.pem"),
		"ANTNEST_EDGE_TLS_KEY_FILE":  filepath.Join(directory, "key.pem"),
		"ANTNEST_EDGE_TLS_CA_FILE":   filepath.Join(directory, "ca.pem"),
	}
	lookup := func(name string) string { return values[name] }
	if err := checkHealth(lookup); err != nil {
		t.Fatalf("native TLS health: %v", err)
	}
	values["ANTNEST_EDGE_PUBLIC_ORIGIN"] = "https://wrong.example"
	if err := checkHealth(lookup); err == nil {
		t.Fatal("health accepted wrong hostname")
	}
	values["ANTNEST_EDGE_PUBLIC_ORIGIN"] = "https://antnest.example"
	other := t.TempDir()
	publicTestCA(t, other)
	values["ANTNEST_EDGE_TLS_CA_FILE"] = filepath.Join(other, "ca.pem")
	if err := checkHealth(lookup); err == nil {
		t.Fatal("health accepted an untrusted certificate")
	}
	values["ANTNEST_EDGE_TLS_CA_FILE"] = filepath.Join(directory, "ca.pem")
	if err := os.WriteFile(values["ANTNEST_EDGE_TLS_CERT_FILE"], []byte("invalid replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkHealth(lookup); err != nil {
		t.Fatalf("last-good serving certificate became unhealthy during failed rotation: %v", err)
	}
}

func TestPublicTLSRotationPreservesWebSocketAndLastValidCertificate(t *testing.T) {
	directory := t.TempDir()
	writePublicTestCertificate(t, directory, 1)
	cfg := config.Config{PublicOrigin: "https://antnest.example", TLSCertFile: filepath.Join(directory, "cert.pem"), TLSKeyFile: filepath.Join(directory, "key.pem")}
	certificates, err := loadPublicTLS(cfg)
	if err != nil {
		t.Fatal(err)
	}
	upgrader := websocket.Upgrader{}
	endpoint := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = connection.Close() }()
		for {
			kind, message, err := connection.ReadMessage()
			if err != nil {
				return
			}
			if err := connection.WriteMessage(kind, message); err != nil {
				return
			}
		}
	}))
	endpoint.TLS = certificates.config()
	endpoint.StartTLS()
	t.Cleanup(endpoint.Close)
	roots := x509.NewCertPool()
	roots.AddCert(publicTestCA(t, directory).Leaf)
	clientTLS := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: "antnest.example"}
	dialer := websocket.Dialer{TLSClientConfig: clientTLS, HandshakeTimeout: time.Second}
	connection, response, err := dialer.Dial(strings.Replace(endpoint.URL, "https:", "wss:", 1), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.Close() }()
	echo := func(message string) {
		t.Helper()
		if err := connection.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		if err := connection.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
			t.Fatal(err)
		}
		if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		_, reply, err := connection.ReadMessage()
		if err != nil || string(reply) != message {
			t.Fatalf("existing WebSocket lost after rotation: %v", err)
		}
	}
	assertSerial := func(want int64) {
		t.Helper()
		peer, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", endpoint.Listener.Addr().String(), clientTLS)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = peer.Close() }()
		if got := peer.ConnectionState().PeerCertificates[0].SerialNumber.Int64(); got != want {
			t.Fatalf("certificate serial=%d want=%d", got, want)
		}
	}
	assertSerial(1)
	echo("before rotation")
	stop := certificates.watch(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer stop()
	writePublicTestCertificate(t, directory, 2)
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for certificates.certificate.Load().Leaf.SerialNumber.Int64() != 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	assertSerial(2)
	echo("after rotation")
	if err := os.WriteFile(cfg.TLSKeyFile, []byte("invalid replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := certificates.reload(); err == nil {
		t.Fatal("invalid replacement accepted")
	}
	assertSerial(2)
	echo("after invalid rotation")
	obsolete := clientTLS.Clone()
	obsolete.MinVersion = tls.VersionTLS10
	obsolete.MaxVersion = tls.VersionTLS11
	peer, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", endpoint.Listener.Addr().String(), obsolete)
	if peer != nil {
		_ = peer.Close()
	}
	if err == nil {
		t.Fatal("TLS older than 1.2 accepted")
	}
}
