package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/config"
)

type publicTLS struct {
	certificate                 atomic.Pointer[tls.Certificate]
	certFile, keyFile, hostname string
}

func loadPublicTLS(cfg config.Config) (*publicTLS, error) {
	origin, err := config.ParsePublicOrigin(cfg.PublicOrigin)
	if err != nil {
		return nil, err
	}
	certificates := &publicTLS{certFile: cfg.TLSCertFile, keyFile: cfg.TLSKeyFile, hostname: origin.Hostname()}
	if err := certificates.reload(); err != nil {
		return nil, err
	}
	return certificates, nil
}

func (certificates *publicTLS) reload() error {
	pair, err := tls.LoadX509KeyPair(certificates.certFile, certificates.keyFile)
	if err != nil {
		return fmt.Errorf("load public certificate: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return fmt.Errorf("parse public certificate: %w", err)
	}
	if err := leaf.VerifyHostname(certificates.hostname); err != nil {
		return fmt.Errorf("public certificate hostname: %w", err)
	}
	if now := time.Now(); now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return fmt.Errorf("public certificate is outside its validity period")
	}
	serverUsage := len(leaf.ExtKeyUsage) == 0 && len(leaf.UnknownExtKeyUsage) == 0
	for _, usage := range leaf.ExtKeyUsage {
		if usage == x509.ExtKeyUsageServerAuth || usage == x509.ExtKeyUsageAny {
			serverUsage = true
		}
	}
	if !serverUsage {
		return fmt.Errorf("public certificate does not permit TLS server authentication")
	}
	pair.Leaf = leaf
	certificates.certificate.Store(&pair)
	return nil
}

func (certificates *publicTLS) config() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return certificates.certificate.Load(), nil
	}}
}

func (certificates *publicTLS) watch(ctx context.Context, logger *slog.Logger) func() {
	ctx, cancel := context.WithCancel(ctx)
	reloads := make(chan os.Signal, 1)
	signal.Notify(reloads, syscall.SIGHUP)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				return
			case <-reloads:
				if err := certificates.reload(); err != nil {
					logger.Error("Public TLS certificate reload rejected; retaining last valid pair", "error_class", "public_tls_reload_failed")
				} else {
					logger.Info("Public TLS certificate reloaded")
				}
			}
		}
	}()
	return func() { signal.Stop(reloads); cancel(); <-done }
}
