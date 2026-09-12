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

	"soft/antnest-platform/services/admin-console/internal/config"
	"soft/antnest-platform/services/admin-console/internal/server"
	"soft/antnest-platform/services/admin-console/internal/telemetry"
	"soft/antnest-platform/services/admin-console/internal/upstream"
	"soft/antnest-platform/services/admin-console/web"
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
	if err := run(ctx, os.Getenv); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error(
			"Admin Console stopped with an error", "error_class", "service_failure",
		)
		os.Exit(1)
	}
}

func run(ctx context.Context, lookup func(string) string) (resultErr error) {
	cfg, err := config.Load(lookup)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	telemetryRuntime, err := telemetry.Setup(ctx, slog.NewJSONHandler(os.Stdout, nil), telemetry.Config{
		ServiceVersion: version, Environment: lookup("ANTNEST_ENVIRONMENT"),
	})
	if err != nil {
		return fmt.Errorf("start telemetry: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, telemetryRuntime.Shutdown(context.Background()))
	}()
	logger := telemetryRuntime.Logger()
	httpClient := &http.Client{Transport: http.DefaultTransport}
	backend, err := upstream.NewClient(upstream.Config{
		IdentityURL: cfg.IdentityURL, AgentControllerURL: cfg.AgentControllerURL,
		HTTPClient: httpClient,
	})
	if err != nil {
		return fmt.Errorf("create upstream client: %w", err)
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
	}, server.Dependencies{Backend: backend, Assets: assets, Logger: logger, StreamContext: streamContext})
	if err != nil {
		return fmt.Errorf("compose Admin Console: %w", err)
	}
	drain := newRequestDrain(telemetry.HTTPHandler(handler, logger))
	httpServer := &http.Server{
		Addr: cfg.ListenAddress, Handler: drain,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
		IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20,
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	logger.Info("Admin Console is ready", "listen_address", cfg.ListenAddress)
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(listener) }()
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

func checkHealth(lookup func(string) string) error {
	listen := strings.TrimSpace(lookup("ANTNEST_ADMIN_CONSOLE_LISTEN"))
	if listen == "" {
		listen = ":8080"
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("parse listen address: %w", err)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/status")
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("admin console status returned %s", response.Status)
	}
	return nil
}
