package serviceauth

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"time"
)

type LookupEnv func(string) (string, bool)

type Config struct {
	Receiver  *Receiver
	ServerTLS *tls.Config
	ClientTLS *tls.Config
}

func LoadConfig(service string, lookup LookupEnv) (Config, error) {
	mode, insecure, err := loadMode(lookup)
	if err != nil {
		return Config{}, err
	}
	var receiver *Receiver
	if mode == "token" {
		path, _ := lookup("ANTNEST_SERVICE_AUTH_CALLERS_FILE")
		raw, err := ReadFile(path, 8192)
		if err != nil {
			return Config{}, fmt.Errorf("ANTNEST_SERVICE_AUTH_CALLERS_FILE must be a readable bounded JSON file")
		}
		receiver, err = ParseReceiver(service, raw, false)
		if err != nil {
			return Config{}, err
		}
	} else {
		if !slices.Contains(Services, service) {
			return Config{}, fmt.Errorf("unknown receiver service identity")
		}
		receiver = &Receiver{mode: "mtls"}
	}
	serverTLS, clientTLS, err := loadTLS(service, mode, insecure, lookup)
	if err != nil {
		return Config{}, err
	}
	return Config{Receiver: receiver, ServerTLS: serverTLS, ClientTLS: clientTLS}, nil
}

// HealthTLS authenticates the server even over loopback; it does not load
// application caller hashes, CCT keys, database settings or user credentials.
func HealthTLS(service string, lookup LookupEnv) (*tls.Config, error) {
	mode, insecure, err := loadMode(lookup)
	if err != nil {
		return nil, err
	}
	_, client, err := loadTLS(service, mode, insecure, lookup)
	return client, err
}

func loadMode(lookup LookupEnv) (string, bool, error) {
	if lookup == nil {
		return "", false, fmt.Errorf("service authentication environment lookup is required")
	}
	mode, _ := lookup("ANTNEST_SERVICE_AUTH_MODE")
	if mode != "token" && mode != "mtls" {
		return "", false, fmt.Errorf("ANTNEST_SERVICE_AUTH_MODE must be exactly token or mtls")
	}
	flag, present := lookup("ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT")
	if !present {
		flag = "false"
	}
	if flag != "true" && flag != "false" {
		return "", false, fmt.Errorf("ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT must be exactly true or false")
	}
	if mode == "mtls" && flag == "true" {
		return "", false, fmt.Errorf("mTLS cannot enable insecure transport")
	}
	return mode, flag == "true", nil
}

func loadTLS(service, mode string, insecure bool, lookup LookupEnv) (*tls.Config, *tls.Config, error) {
	caPath, _ := lookup("ANTNEST_TLS_CA_FILE")
	certPath, _ := lookup("ANTNEST_TLS_CERT_FILE")
	keyPath, _ := lookup("ANTNEST_TLS_KEY_FILE")
	serverName, _ := lookup("ANTNEST_TLS_SERVER_NAME")
	if insecure && caPath == "" && certPath == "" && keyPath == "" && serverName == "" {
		return nil, nil, nil
	}
	if caPath == "" || certPath == "" || keyPath == "" || serverName == "" {
		return nil, nil, fmt.Errorf("complete TLS configuration is required; plaintext fallback is forbidden")
	}
	caPEM, err := ReadFile(caPath, 65536)
	if err != nil {
		return nil, nil, fmt.Errorf("TLS CA file cannot be read")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, nil, fmt.Errorf("TLS CA file contains no certificates")
	}
	certPEM, err := ReadFile(certPath, 65536)
	if err != nil {
		return nil, nil, fmt.Errorf("TLS certificate file cannot be read")
	}
	keyPEM, err := ReadFile(keyPath, 8192)
	if err != nil {
		return nil, nil, fmt.Errorf("TLS private key file cannot be read")
	}
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil || len(certificate.Certificate) == 0 {
		return nil, nil, fmt.Errorf("TLS certificate and private key are invalid")
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil || !certificateIdentity(leaf, service) {
		return nil, nil, fmt.Errorf("TLS certificate has the wrong service URI identity")
	}
	intermediates := x509.NewCertPool()
	for _, der := range certificate.Certificate[1:] {
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, nil, fmt.Errorf("TLS intermediate certificate is invalid")
		}
		intermediates.AddCert(cert)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates,
		DNSName: serverName, CurrentTime: time.Now(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		return nil, nil, fmt.Errorf("TLS server certificate trust, expiry or DNS identity is invalid")
	}
	client := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: serverName,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 || !certificateIdentity(state.PeerCertificates[0], service) {
				return fmt.Errorf("TLS server service identity is invalid")
			}
			return nil
		}}
	server := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{certificate}}
	if mode == "mtls" {
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates,
			CurrentTime: time.Now(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
			return nil, nil, fmt.Errorf("mTLS certificate lacks valid client usage")
		}
		server.ClientAuth, server.ClientCAs = tls.RequireAndVerifyClientCert, roots
		server.VerifyConnection = func(state tls.ConnectionState) error {
			if verifiedTLSCaller(&http.Request{TLS: &state}) == "" {
				return fmt.Errorf("mTLS client service identity is invalid")
			}
			return nil
		}
		client.Certificates = []tls.Certificate{certificate}
	}
	return server, client, nil
}

func certificateIdentity(certificate *x509.Certificate, service string) bool {
	return certificate != nil && len(certificate.URIs) == 1 &&
		certificate.URIs[0].String() == "antnest://service/"+service
}

func ReadFile(path string, limit int64) ([]byte, error) {
	if path == "" {
		return nil, fmt.Errorf("file path is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("regular credential file required")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, fmt.Errorf("credential file unreadable or oversized")
	}
	return raw, nil
}
