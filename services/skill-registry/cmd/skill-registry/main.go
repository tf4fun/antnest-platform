package main

import (
	"context"
	"crypto/tls"
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

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/registry"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/telemetry"
)

type config struct {
	listenAddress string
	databaseURL   string
	sourceURL     string
	identityURL   string
	clients       *serviceauth.Clients
	security      registry.Security
}

func loadConfig(lookup serviceauth.LookupEnv) (config, error) {
	if lookup == nil {
		return config{}, fmt.Errorf("registry environment lookup is required")
	}
	get := func(k string) string { v, _ := lookup(k); return v }
	value := config{listenAddress: strings.TrimSpace(get("ANTNEST_SKILL_REGISTRY_LISTEN")), databaseURL: strings.TrimSpace(get("ANTNEST_SKILL_REGISTRY_DATABASE_URL")), sourceURL: strings.TrimSpace(get("ANTNEST_SKILL_REGISTRY_SOURCE_URL")), identityURL: strings.TrimSpace(get("ANTNEST_IDENTITY_URL"))}
	if value.listenAddress == "" {
		value.listenAddress = ":8080"
	}
	if _, _, err := net.SplitHostPort(value.listenAddress); err != nil {
		return config{}, fmt.Errorf("invalid Registry listen address")
	}
	if value.databaseURL == "" {
		return config{}, fmt.Errorf("ANTNEST_SKILL_REGISTRY_DATABASE_URL is required")
	}
	if value.identityURL == "" {
		return config{}, fmt.Errorf("ANTNEST_IDENTITY_URL is required")
	}
	for _, name := range []string{"ANTNEST_SKILL_REGISTRY_API_TOKEN", "ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN"} {
		if get(name) != "" {
			return config{}, fmt.Errorf("%s is retired; use service authentication files", name)
		}
	}
	endpoints := map[string]string{"identity-service": value.identityURL}
	if value.sourceURL != "" {
		endpoints["agent-acp-service"] = value.sourceURL
	}
	clients, err := serviceauth.LoadOutbound(lookup, endpoints)
	if err != nil {
		return config{}, err
	}
	valid := false
	defer func() {
		if !valid {
			clients.CloseIdleConnections()
		}
	}()
	verifier, err := callercontext.NewVerifier(value.identityURL, clients.HTTPClient(), 5*time.Second)
	if err != nil {
		return config{}, fmt.Errorf("invalid Registry Identity configuration")
	}
	if value.sourceURL != "" {
		if _, err := registry.NewHTTPAgentSource(value.sourceURL, clients.HTTPClient()); err != nil {
			return config{}, fmt.Errorf("invalid Registry source-reader configuration")
		}
	}
	value.clients = clients
	value.security = registry.Security{Authentication: clients.Config.Receiver, CallerContext: verifier}
	valid = true
	return value, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		if err := healthcheck(os.LookupEnv); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.LookupEnv); err != nil {
		slog.Error("Skill Registry stopped", "error", err.Error())
		os.Exit(1)
	}
}

func healthcheck(lookup serviceauth.LookupEnv) error {
	rawAddress, _ := lookup("ANTNEST_SKILL_REGISTRY_LISTEN")
	address, err := healthProbeAddress(rawAddress)
	if err != nil {
		return fmt.Errorf("invalid healthcheck listen address")
	}
	tlsConfig, err := serviceauth.HealthTLS("skill-registry", lookup)
	if err != nil {
		return err
	}
	transport := &http.Transport{TLSClientConfig: tlsConfig, Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	scheme := "http"
	if tlsConfig != nil {
		scheme = "https"
	}
	response, err := client.Get(scheme + "://" + address + "/status")
	if err != nil {
		return fmt.Errorf("registry healthcheck request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("registry healthcheck status %d", response.StatusCode)
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

func run(ctx context.Context, lookup serviceauth.LookupEnv) error {
	cfg, err := loadConfig(lookup)
	if err != nil {
		return err
	}
	defer cfg.clients.CloseIdleConnections()
	observability, err := telemetry.Setup(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if err := observability.Shutdown(context.Background()); err != nil {
			slog.Error("Registry telemetry shutdown failed", "error_class", "export_error")
		}
	}()
	poolConfig, err := pgxpool.ParseConfig(cfg.databaseURL)
	if err != nil {
		return fmt.Errorf("invalid Registry database configuration")
	}
	poolConfig.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return fmt.Errorf("open Registry database pool: %w", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("registry database is unavailable")
	}
	if err := registry.ApplyMigrations(ctx, pool); err != nil {
		return fmt.Errorf("registry schema migration failed: %w", err)
	}
	listener, err := net.Listen("tcp", cfg.listenAddress)
	if err != nil {
		return fmt.Errorf("registry listener failed: %w", err)
	}
	defer func() { _ = listener.Close() }()
	store := registry.NewPostgresStore(pool)
	service := registry.NewService(store)
	var source registry.AgentSkillSource
	if cfg.sourceURL != "" {
		source, err = registry.NewHTTPAgentSource(cfg.sourceURL, cfg.clients.HTTPClient())
		if err != nil {
			return err
		}
	}
	discovery := registry.NewDiscovery(service, store, source)
	handler, err := registry.NewHandler(service, cfg.security, pool.Ping, discovery)
	if err != nil {
		_ = listener.Close()
		return err
	}
	server := &http.Server{
		Handler:           handler,
		TLSConfig:         cfg.clients.Config.ServerTLS,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      45 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	defer func() { _ = server.Close() }()
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	shutdown := make(chan error, 1)
	go func() {
		<-serveCtx.Done()
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		shutdown <- server.Shutdown(stopCtx)
	}()
	if server.TLSConfig != nil {
		listener = tls.NewListener(listener, server.TLSConfig)
	}
	err = server.Serve(listener)
	cancel()
	if shutdownErr := <-shutdown; shutdownErr != nil {
		return shutdownErr
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
