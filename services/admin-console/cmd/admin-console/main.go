package main

import (
	"context"
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

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/config"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/server"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/telemetry"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
	"github.com/tf4fun/antnest-platform/services/admin-console/web"
)

var version = "dev"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		if err := checkHealth(os.LookupEnv); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.LookupEnv); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error(
			"Admin Console stopped with an error", "error_class", "service_failure",
		)
		os.Exit(1)
	}
}

func run(ctx context.Context, lookup serviceauth.LookupEnv) (resultErr error) {
	getenv := func(key string) string { value, _ := lookup(key); return value }
	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	endpoints := map[string]string{"identity-service": cfg.IdentityURL, "agent-controller": cfg.AgentControllerURL, "agent-acp-service": cfg.AgentACPURL}
	if cfg.SkillRegistryURL != "" {
		endpoints["skill-registry"] = cfg.SkillRegistryURL
	}
	clients, err := serviceauth.LoadOutbound("admin-console", serviceauth.CallerContextHeaders, lookup, endpoints)
	if err != nil {
		return fmt.Errorf("load service authentication: %w", err)
	}
	defer clients.CloseIdleConnections()
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
	httpClient := clients.HTTPClient()
	jwksClient := *httpClient
	jwksClient.Transport = telemetry.NewHTTPTransport(jwksClient.Transport)
	verifier, err := callercontext.NewVerifier(cfg.IdentityURL, &jwksClient, cfg.DependencyTimeout)
	if err != nil {
		return fmt.Errorf("create caller-context verifier: %w", err)
	}
	backend, err := upstream.NewClient(upstream.Config{
		IdentityURL: cfg.IdentityURL, AgentControllerURL: cfg.AgentControllerURL, AgentACPURL: cfg.AgentACPURL,
		HTTPClient: httpClient,
	})
	if err != nil {
		return fmt.Errorf("create upstream client: %w", err)
	}
	var registryClient server.RegistryBackend
	if cfg.SkillRegistryURL != "" {
		registryClient, err = upstream.NewRegistryClient(cfg.SkillRegistryURL, httpClient)
		if err != nil {
			return fmt.Errorf("create Skill Registry client: %w", err)
		}
	}
	assets, err := web.Dist()
	if err != nil {
		return fmt.Errorf("load embedded application: %w", err)
	}
	streamContext, stopStreams := context.WithCancel(context.Background())
	defer stopStreams()
	handler, err := server.NewHandler(server.Config{
		DefaultRuntimeImageRef: cfg.DefaultRuntimeImageRef,
		RequestTimeout:         cfg.DependencyTimeout,
	}, server.Dependencies{Authentication: clients.Config.Receiver, CallerContext: verifier, Backend: backend, Registry: registryClient, Assets: assets, Logger: logger, StreamContext: streamContext})
	if err != nil {
		return fmt.Errorf("compose Admin Console: %w", err)
	}
	drain := newRequestDrain(telemetry.HTTPHandler(handler, logger))
	httpServer := &http.Server{
		Addr: cfg.ListenAddress, Handler: drain,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
		IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20,
		TLSConfig: clients.Config.ServerTLS,
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	logger.Info("Admin Console is ready", "listen_address", cfg.ListenAddress)
	serveErrors := make(chan error, 1)
	go func() {
		if httpServer.TLSConfig != nil {
			serveErrors <- httpServer.ServeTLS(listener, "", "")
		} else {
			serveErrors <- httpServer.Serve(listener)
		}
	}()
	select {
	case <-ctx.Done():
	case err = <-serveErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			resultErr = fmt.Errorf("serve HTTP: %w", err)
		}
	}
	drain.stop()
	stopStreams()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		resultErr = errors.Join(resultErr, fmt.Errorf("shutdown HTTP: %w", err), httpServer.Close())
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelCleanup()
		if err := drain.wait(cleanupCtx); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("drain cancelled HTTP handlers: %w", err))
		}
	}
	return resultErr
}

func checkHealth(lookup serviceauth.LookupEnv) error {
	rawListen, _ := lookup("ANTNEST_ADMIN_CONSOLE_LISTEN")
	address, err := healthProbeAddress(rawListen)
	if err != nil {
		return fmt.Errorf("parse listen address: %w", err)
	}
	tlsConfig, err := serviceauth.HealthTLS("admin-console", lookup)
	if err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = tlsConfig
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 2 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	scheme := "http"
	if tlsConfig != nil {
		scheme = "https"
	}
	response, err := client.Get(scheme + "://" + address + "/status")
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("admin console status returned %s", response.Status)
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
