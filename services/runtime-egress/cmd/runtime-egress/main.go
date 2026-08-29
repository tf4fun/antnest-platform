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
	"syscall"
	"time"

	"soft/antnest-platform/services/runtime-egress/internal/config"
	"soft/antnest-platform/services/runtime-egress/internal/control"
	"soft/antnest-platform/services/runtime-egress/internal/dnsproxy"
	"soft/antnest-platform/services/runtime-egress/internal/egress"
	"soft/antnest-platform/services/runtime-egress/internal/httpapi"
	"soft/antnest-platform/services/runtime-egress/internal/telemetry"
	"soft/antnest-platform/services/runtime-egress/internal/tunnel"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		if err := checkHealth(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("runtime egress stopped", "error", err)
		os.Exit(1)
	}
}

func checkHealth() error {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:8081/readyz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime egress readiness returned %s", response.Status)
	}
	return nil
}

func run(ctx context.Context) error {
	telemetryRuntime, err := telemetry.Setup(ctx, slog.NewJSONHandler(os.Stdout, nil), telemetry.Config{
		ServiceName: "runtime-egress",
	})
	if err != nil {
		return err
	}
	slog.SetDefault(telemetryRuntime.Logger())
	defer telemetryRuntime.Shutdown(context.Background())

	configuration, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	gateway := egress.New()
	if err := gateway.Start(ctx, configuration.TunnelCIDR); err != nil {
		return fmt.Errorf("start Runtime egress data plane: %w", err)
	}
	defer gateway.Close()
	dns, err := dnsproxy.New(net.JoinHostPort(configuration.DNSIPv4, "53"), configuration.DNSUpstream)
	if err != nil {
		return err
	}
	if err := dns.Start(ctx); err != nil {
		return err
	}
	defer dns.Close()
	service, err := control.New(gateway)
	if err != nil {
		return err
	}
	verifier, err := tunnel.NewTokenVerifier(configuration.TokenSecret)
	if err != nil {
		return err
	}
	tunnelServer, err := tunnel.NewServer(verifier, service, gateway, egress.DefaultMTU)
	if err != nil {
		return err
	}
	internalHandler, err := httpapi.New(service, func(context.Context) error {
		if !gateway.Ready() {
			return fmt.Errorf("Runtime egress data plane is not ready")
		}
		if !dns.Ready() {
			return fmt.Errorf("Runtime DNS proxy is not ready")
		}
		return nil
	})
	if err != nil {
		return err
	}
	runtimeMux := http.NewServeMux()
	runtimeMux.HandleFunc("GET /runtime/v1/tunnel", tunnelServer.TunnelHandler)
	internalHTTP := &http.Server{
		Addr: configuration.ListenAddress, Handler: telemetry.HTTPHandler(internalHandler),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute,
	}
	runtimeHTTP := &http.Server{
		Addr: configuration.RuntimeListenAddress, Handler: runtimeMux,
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute,
	}
	errorsChannel := make(chan error, 2)
	go func() { errorsChannel <- serveHTTP(internalHTTP) }()
	go func() { errorsChannel <- serveHTTP(runtimeHTTP) }()
	slog.Info("runtime egress started",
		"internal_address", configuration.ListenAddress,
		"runtime_address", configuration.RuntimeListenAddress,
	)

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errorsChannel:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	shutdownErr := errors.Join(internalHTTP.Shutdown(shutdownCtx), runtimeHTTP.Shutdown(shutdownCtx))
	return errors.Join(runErr, shutdownErr)
}

func serveHTTP(server *http.Server) error {
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
