package serviceauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOutboundTLSAuthenticatesActualReceiverAndMTLSCaller(t *testing.T) {
	for _, mode := range []string{"token", "mtls"} {
		for _, wrongURI := range []bool{false, true} {
			t.Run(mode+map[bool]string{false: "/valid", true: "/wrong-server-URI"}[wrongURI], func(t *testing.T) {
				_, caKey, _ := ed25519.GenerateKey(rand.Reader)
				now := time.Now()
				ca := &x509.Certificate{SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour)}
				caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, caKey.Public(), caKey)
				if err != nil {
					t.Fatal(err)
				}
				certificate := func(service string) ([]byte, []byte) {
					_, key, _ := ed25519.GenerateKey(rand.Reader)
					identity, _ := url.Parse("antnest://service/" + service)
					leaf := &x509.Certificate{SerialNumber: big.NewInt(2), URIs: []*url.URL{identity}, DNSNames: []string{service + ".internal"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
					der, err := x509.CreateCertificate(rand.Reader, leaf, ca, key.Public(), caKey)
					if err != nil {
						t.Fatal(err)
					}
					privateDER, err := x509.MarshalPKCS8PrivateKey(key)
					if err != nil {
						t.Fatal(err)
					}
					return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER})
				}
				env := outboundEnvironment(t, "identity-service", testToken(t))
				env["ANTNEST_SERVICE_AUTH_MODE"], env["ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT"] = mode, "false"
				dir := t.TempDir()
				gatewayCert, gatewayKey := certificate("skill-registry")
				for name, data := range map[string][]byte{"ca.pem": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), "cert.pem": gatewayCert, "key.pem": gatewayKey} {
					if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
						t.Fatal(err)
					}
				}
				env["ANTNEST_TLS_CA_FILE"], env["ANTNEST_TLS_CERT_FILE"], env["ANTNEST_TLS_KEY_FILE"], env["ANTNEST_TLS_SERVER_NAME"] = filepath.Join(dir, "ca.pem"), filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"), "skill-registry.internal"
				serverIdentity := "identity-service"
				if wrongURI {
					serverIdentity = "skill-registry"
				}
				certPEM, keyPEM := certificate(serverIdentity)
				serverCertificate, err := tls.X509KeyPair(certPEM, keyPEM)
				if err != nil {
					t.Fatal(err)
				}
				server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if mode == "mtls" && verifiedTLSCaller(r) != "skill-registry" {
						t.Error("mTLS lost caller identity")
					}
					if mode == "mtls" && r.Header.Get(Header) != "" {
						t.Error("mTLS fell back to bearer")
					}
					if mode == "token" && r.Header.Get(Header) == "" {
						t.Error("token authentication omitted")
					}
					w.WriteHeader(204)
				}))
				// The trust pool must use the parsed DER-backed CA.
				parsedCA, err := x509.ParseCertificate(caDER)
				if err != nil {
					t.Fatal(err)
				}
				pool := x509.NewCertPool()
				pool.AddCert(parsedCA)
				server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCertificate}}
				if mode == "mtls" {
					server.TLS.ClientAuth = tls.RequireAndVerifyClientCert
					server.TLS.ClientCAs = pool
				}
				server.Config.ErrorLog = log.New(io.Discard, "", 0)
				server.StartTLS()
				defer server.Close()
				clients, err := LoadOutbound(lookupEnvironment(env), map[string]string{"identity-service": server.URL})
				if err != nil {
					t.Fatal(err)
				}
				defer clients.CloseIdleConnections()
				response, err := clients.HTTPClient().Get(server.URL)
				if response != nil {
					_ = response.Body.Close()
				}
				if wrongURI && err == nil {
					t.Fatal("valid DNS/CA certificate with the wrong receiver URI was accepted")
				}
				if !wrongURI && (err != nil || response.StatusCode != 204) {
					t.Fatalf("authenticated connection failed: %v", err)
				}
			})
		}
	}
}
