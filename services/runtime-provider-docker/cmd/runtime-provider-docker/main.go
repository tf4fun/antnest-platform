package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"soft/antnest-platform/services/runtime-provider-docker/internal/config"
	"soft/antnest-platform/services/runtime-provider-docker/internal/dockerengine"
	"soft/antnest-platform/services/runtime-provider-docker/internal/httpapi"
	"soft/antnest-platform/services/runtime-provider-docker/internal/telemetry"
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
		slog.Error("Docker Runtime Provider stopped", "error", err)
		os.Exit(1)
	}
}

func checkHealth() error {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:8082/readyz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Docker Runtime Provider readiness returned %s", response.Status)
	}
	return nil
}

func run(ctx context.Context) error {
	telemetryRuntime, err := telemetry.Setup(ctx, slog.NewJSONHandler(os.Stdout, nil), telemetry.Config{
		ServiceName: "runtime-provider-docker",
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
	engine, err := dockerengine.NewUnixClient(configuration.DockerSocket)
	if err != nil {
		return err
	}
	driver, err := dockerengine.NewDriver(engine)
	if err != nil {
		return err
	}
	handler, err := httpapi.New(driver, engine.Ping)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr: configuration.ListenAddress, Handler: telemetry.HTTPHandler(handler),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute,
	}
	errorsChannel := make(chan error, 1)
	go func() { errorsChannel <- serveHTTP(server) }()
	slog.Info("Docker Runtime Provider started", "address", configuration.ListenAddress)
	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errorsChannel:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return errors.Join(runErr, server.Shutdown(shutdownCtx))
}

func serveHTTP(server *http.Server) error {
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
