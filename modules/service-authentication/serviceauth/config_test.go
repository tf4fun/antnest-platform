package serviceauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestModesAuthenticateOverRealTLSAndRejectDowngrades(t *testing.T) {
	for _, mode := range []string{"token", "mtls"} {
		t.Run(mode, func(t *testing.T) {
			env := testTLSFiles(t, "identity-service")
			env["ANTNEST_SERVICE_AUTH_MODE"] = mode
			path := filepath.Join(t.TempDir(), "callers.json")
			if err := os.WriteFile(path, []byte(`{"edge-gateway":["sha256:ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0"]}`), 0o600); err != nil {
				t.Fatal(err)
			}
			env["ANTNEST_SERVICE_AUTH_CALLERS_FILE"] = path
			cfg, err := LoadConfig("identity-service", func(key string) (string, bool) { v, p := env[key]; return v, p })
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				allowed := []string{"edge-gateway"}
				if mode == "mtls" {
					allowed = []string{"identity-service"}
				}
				if _, err := cfg.Receiver.Authorize(r, allowed); err != nil {
					w.WriteHeader(401)
					return
				}
				w.WriteHeader(200)
			}))
			server.TLS = cfg.ServerTLS
			server.Config.ErrorLog = log.New(io.Discard, "", 0)
			server.StartTLS()
			t.Cleanup(server.Close)
			for _, scenario := range []string{"valid", "bad DNS", "TLS 1.2", "no credential"} {
				t.Run(scenario, func(t *testing.T) {
					tlsConfig := cfg.ClientTLS.Clone()
					if scenario == "bad DNS" {
						tlsConfig.ServerName = "untrusted.invalid"
					}
					if scenario == "TLS 1.2" {
						tlsConfig.MinVersion = tls.VersionTLS12
						tlsConfig.MaxVersion = tls.VersionTLS12
					}
					if scenario == "no credential" {
						tlsConfig.Certificates = nil
					}
					transport := &http.Transport{TLSClientConfig: tlsConfig}
					defer transport.CloseIdleConnections()
					client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
					request, err := http.NewRequestWithContext(t.Context(), "GET", server.URL, nil)
					if err != nil {
						t.Fatal(err)
					}
					if scenario != "no credential" {
						request.Header.Set(Header, "Bearer AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
					}
					response, err := client.Do(request)
					if response != nil {
						defer func() { _ = response.Body.Close() }()
					}
					if scenario == "valid" {
						if err != nil || response.StatusCode != 200 {
							t.Fatalf("valid TLS authentication failed: %v response=%v", err, response)
						}
						return
					}
					if scenario == "no credential" && mode == "token" {
						if err != nil || response.StatusCode != 401 {
							t.Fatal("token omission was accepted")
						}
						return
					}
					if err == nil {
						t.Fatal("TLS identity or version downgrade was accepted")
					}
				})
			}
		})
	}
}

func TestStartupUsesSharedModeAndTransportVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../contracts/platform/service-token-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Vectors []struct {
			Name      string  `json:"name"`
			Mode      *string `json:"mode"`
			Insecure  *string `json:"allow_insecure_transport"`
			Transport string  `json:"transport"`
			Valid     bool    `json:"valid"`
		} `json:"mode_vectors"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, vector := range fixtures.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			environment := make(map[string]string)
			if vector.Mode != nil {
				environment["ANTNEST_SERVICE_AUTH_MODE"] = *vector.Mode
			}
			if vector.Insecure != nil {
				environment["ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT"] = *vector.Insecure
			}
			path := filepath.Join(t.TempDir(), "callers.json")
			if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
				t.Fatal(err)
			}
			environment["ANTNEST_SERVICE_AUTH_CALLERS_FILE"] = path
			if vector.Transport == "https" {
				for key, value := range testTLSFiles(t, "identity-service") {
					environment[key] = value
				}
			}
			_, err := LoadConfig("identity-service", func(key string) (string, bool) {
				value, present := environment[key]
				return value, present
			})
			if (err == nil) != vector.Valid {
				t.Fatalf("startup accepted=%v want=%v error=%v", err == nil, vector.Valid, err)
			}
		})
	}
}

func TestStartupRejectsMissingReceiverFileAndPartialTLS(t *testing.T) {
	for _, test := range []struct {
		name string
		env  map[string]string
	}{
		{"missing receiver", map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true"}},
		{"unreadable receiver", map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": "/missing/callers.json"}},
		{"partial TLS despite opt-in", map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_TLS_CA_FILE": "/missing/ca.pem"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.name == "partial TLS despite opt-in" {
				path := filepath.Join(t.TempDir(), "callers.json")
				if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
					t.Fatal(err)
				}
				test.env["ANTNEST_SERVICE_AUTH_CALLERS_FILE"] = path
			}
			if _, err := LoadConfig("identity-service", func(key string) (string, bool) {
				value, present := test.env[key]
				return value, present
			}); err == nil {
				t.Fatal("partial authentication must not permit startup")
			}
		})
	}
}

func TestStartupBindsTLSCertificateToReceiverIdentity(t *testing.T) {
	environment := testTLSFiles(t, "edge-gateway")
	environment["ANTNEST_SERVICE_AUTH_MODE"] = "mtls"
	if _, err := LoadConfig("identity-service", func(key string) (string, bool) {
		value, present := environment[key]
		return value, present
	}); err == nil {
		t.Fatal("another service's valid certificate cannot impersonate Identity")
	}
}

func TestMTLSNeverFallsBackToBearerOrUnverifiedPeer(t *testing.T) {
	receiver := &Receiver{mode: "mtls"}
	for _, state := range []*tls.ConnectionState{nil, {}, {PeerCertificates: []*x509.Certificate{{}}}} {
		request := httptest.NewRequest(http.MethodGet, "/rpc/identity/jwks", nil)
		request.TLS = state
		request.Header.Set(Header, "Bearer AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
		if _, err := receiver.Authorize(request, []string{"edge-gateway"}); err == nil {
			t.Fatal("unverified TLS peer or bearer bypassed selected mTLS mode")
		}
	}
}

func testTLSFiles(t *testing.T, service string) map[string]string {
	t.Helper()
	now := time.Now()
	_, caKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, caKey.Public(), caKey)
	if err != nil {
		t.Fatal(err)
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := url.Parse("antnest://service/" + service)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{service}, URIs: []*url.URL{identity},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}}
	certDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, key.Public(), caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	result := map[string]string{"ANTNEST_TLS_SERVER_NAME": service}
	for _, file := range []struct {
		variable, name, kind string
		bytes                []byte
	}{
		{"ANTNEST_TLS_CA_FILE", "ca.pem", "CERTIFICATE", caDER},
		{"ANTNEST_TLS_CERT_FILE", "cert.pem", "CERTIFICATE", certDER},
		{"ANTNEST_TLS_KEY_FILE", "key.pem", "PRIVATE KEY", keyDER},
	} {
		path := filepath.Join(directory, file.name)
		if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: file.kind, Bytes: file.bytes}), 0o600); err != nil {
			t.Fatal(err)
		}
		result[file.variable] = path
	}
	return result
}
