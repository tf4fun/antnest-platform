package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentacp"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/config"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/server"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

var version = "dev"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		if err := checkHealth(os.Getenv); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.LookupEnv); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error(
			"Edge Gateway stopped with an error", "error_class", "service_failure",
		)
		os.Exit(1)
	}
}

func run(ctx context.Context, lookup serviceauth.LookupEnv) (resultErr error) {
	getenv := func(name string) string { value, _ := lookup(name); return value }
	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	internal, err := serviceauth.LoadOutbound("edge-gateway", serviceauth.GatewayHeaders, lookup, map[string]string{
		"identity-service": cfg.IdentityURL, "admin-console": cfg.AdminConsoleURL,
		"agent-ui": cfg.AgentUIURL, "agent-controller": cfg.AgentControllerURL, "agent-acp-service": cfg.AgentACPURL,
	})
	if err != nil {
		return fmt.Errorf("load internal authentication: %w", err)
	}
	defer internal.CloseIdleConnections()
	telemetryRuntime, err := telemetry.Setup(ctx, slog.NewJSONHandler(os.Stdout, nil), telemetry.Config{
		ServiceVersion: version, Environment: getenv("ANTNEST_ENVIRONMENT"),
	})
	if err != nil {
		return fmt.Errorf("start telemetry: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, telemetryRuntime.Shutdown(context.Background()))
	}()
	logger := telemetryRuntime.Logger()
	if !cfg.CookieSecure {
		logger.Warn("Insecure browser cookies enabled on a loopback development listener")
	}
	var certificates *publicTLS
	if cfg.TLSCertFile != "" {
		certificates, err = loadPublicTLS(cfg)
		if err != nil {
			return fmt.Errorf("load public TLS: %w", err)
		}
		stopReload := certificates.watch(ctx, logger)
		defer stopReload()
	}

	httpClient := internal.HTTPClient()
	httpClient.Transport = telemetry.NewHTTPTransport(httpClient.Transport)
	identityClient, err := identity.NewClient(cfg.IdentityURL, httpClient)
	if err != nil {
		return fmt.Errorf("create Identity client: %w", err)
	}
	agentClient, err := agentcontroller.NewClient(cfg.AgentControllerURL, httpClient)
	if err != nil {
		return fmt.Errorf("create Agent Controller client: %w", err)
	}
	executionClient, err := agentacp.NewClient(cfg.AgentACPURL, httpClient)
	if err != nil {
		return fmt.Errorf("create Agent ACP client: %w", err)
	}
	sessions, err := session.NewManager(session.Config{Secure: cfg.CookieSecure})
	if err != nil {
		return fmt.Errorf("create session manager: %w", err)
	}
	handler, err := server.NewHandler(server.Config{
		PublicOrigin: cfg.PublicOrigin, TrustedProxies: cfg.TrustedProxies,
		AdminConsoleURL: cfg.AdminConsoleURL, AgentUIURL: cfg.AgentUIURL,
		AgentACPURL: cfg.AgentACPURL, IdentityURL: cfg.IdentityURL, RequestTimeout: cfg.RequestTimeout,
		StreamLease: cfg.StreamLease, LoginWindow: cfg.LoginWindow,
		LoginSourceMax: cfg.LoginSourceMax, LoginAccountMax: cfg.LoginAccountMax,
	}, server.Dependencies{
		Identity: identityClient, Agents: agentClient, Execution: executionClient, Sessions: sessions,
		HTTPClient: httpClient, Logger: logger,
	})
	if err != nil {
		return fmt.Errorf("compose Gateway: %w", err)
	}
	lifecycle := newStreamLifecycle(telemetry.HTTPHandler(handler, logger), logger)
	defer lifecycle.stop()
	httpServer := &http.Server{
		Addr: cfg.ListenAddress, Handler: lifecycle,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
		IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20,
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	if certificates != nil {
		httpServer.TLSConfig = certificates.config()
		listener = tls.NewListener(listener, httpServer.TLSConfig)
	}
	logger.Info("Edge Gateway is ready", "listen_address", cfg.ListenAddress)
	return serveHTTP(ctx, httpServer, listener, lifecycle, cfg.ShutdownTimeout)
}

func serveHTTP(
	ctx context.Context, httpServer *http.Server, listener net.Listener,
	lifecycle *streamLifecycle, timeout time.Duration,
) (resultErr error) {
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(listener) }()
	select {
	case <-ctx.Done():
	case err := <-serveErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			resultErr = fmt.Errorf("serve HTTP: %w", err)
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	lifecycle.stop()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		resultErr = errors.Join(resultErr, fmt.Errorf("shutdown HTTP: %w", err), httpServer.Close())
	}
	if err := lifecycle.wait(shutdownCtx); err != nil {
		resultErr = errors.Join(resultErr, fmt.Errorf("drain HTTP handlers: %w", err))
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelCleanup()
		if err := lifecycle.wait(cleanupCtx); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("drain cancelled HTTP handlers: %w", err))
		}
	}
	return resultErr
}

func checkHealth(lookup func(string) string) error {
	address, err := healthProbeAddress(lookup("ANTNEST_EDGE_LISTEN"))
	if err != nil {
		return fmt.Errorf("parse listen address: %w", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	scheme := "http"
	if certFile := strings.TrimSpace(lookup("ANTNEST_EDGE_TLS_CERT_FILE")); certFile != "" {
		origin, err := config.ParsePublicOrigin(strings.TrimSpace(lookup("ANTNEST_EDGE_PUBLIC_ORIGIN")))
		if err != nil {
			return err
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			return fmt.Errorf("load public health trust roots: %w", err)
		}
		if caFile := strings.TrimSpace(lookup("ANTNEST_EDGE_TLS_CA_FILE")); caFile != "" {
			certificate, err := os.ReadFile(caFile)
			if err != nil {
				return fmt.Errorf("read public health CA: %w", err)
			}
			if !roots.AppendCertsFromPEM(certificate) {
				return fmt.Errorf("invalid public health CA")
			}
		}
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: origin.Hostname()}
		scheme = "https"
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	response, err := client.Get(scheme + "://" + address + "/status")
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway status returned %s", response.Status)
	}
	return nil
}

func healthProbeAddress(raw string) (string, error) {
	address := strings.TrimSpace(raw)
	if address == "" {
		address = ":8080"
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", err
	}
	if ip := net.ParseIP(host); host == "" || ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port), nil
}
