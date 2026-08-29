package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"soft/antnest-platform/services/runtime-controller/internal/admission"
	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/config"
	"soft/antnest-platform/services/runtime-controller/internal/egressclient"
	"soft/antnest-platform/services/runtime-controller/internal/httpapi"
	"soft/antnest-platform/services/runtime-controller/internal/postgres"
	"soft/antnest-platform/services/runtime-controller/internal/reconcileworker"
	"soft/antnest-platform/services/runtime-controller/internal/runtimeconn"
	"soft/antnest-platform/services/runtime-controller/internal/runtimeprovider"
	"soft/antnest-platform/services/runtime-controller/internal/telemetry"
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
		slog.Error("runtime controller stopped", "error", err)
		os.Exit(1)
	}
}

func checkHealth() error {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:8080/readyz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime controller readiness returned %s", response.Status)
	}
	return nil
}

func run(ctx context.Context) error {
	telemetryRuntime, err := telemetry.Setup(ctx, slog.NewJSONHandler(os.Stdout, nil), telemetry.Config{
		ServiceName: "runtime-controller",
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
	database, err := sql.Open("pgx", configuration.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open runtime database: %w", err)
	}
	defer database.Close()
	database.SetMaxOpenConns(20)
	database.SetMaxIdleConns(5)
	if err := database.PingContext(ctx); err != nil {
		return fmt.Errorf("connect runtime database: %w", err)
	}
	if err := postgres.Migrate(ctx, database); err != nil {
		return err
	}
	repository, err := postgres.New(database)
	if err != nil {
		return err
	}
	queue := reconcileworker.NewSignalQueue(1024)
	now := func() time.Time { return time.Now().UTC() }
	service, err := application.NewServiceWithTunnelCIDR(
		repository, queue, randomIDs{}, now, configuration.TunnelCIDR,
	)
	if err != nil {
		return err
	}
	issuer, err := admission.NewIssuer(configuration.TokenSecret)
	if err != nil {
		return err
	}
	admissionStore, err := admission.NewStore(repository, service, issuer, now)
	if err != nil {
		return err
	}
	registry, err := runtimeconn.NewRuntimeRegistry(admissionStore)
	if err != nil {
		return err
	}
	defer registry.Close()
	workExecutor, err := runtimeconn.NewWorkExecutor(registry)
	if err != nil {
		return err
	}
	workService, err := application.NewWorkService(repository, workExecutor)
	if err != nil {
		return err
	}
	egressHTTP, err := egressclient.New(egressclient.DefaultHTTPClient(), configuration.EgressURL)
	if err != nil {
		return err
	}
	egressTokens, err := egressclient.NewTokenIssuer(configuration.TokenSecret)
	if err != nil {
		return err
	}
	if err := registry.SetEgress(egressTokens, configuration.EgressEndpoint); err != nil {
		return err
	}
	provider, err := runtimeprovider.New(runtimeprovider.DefaultHTTPClient(), configuration.ProviderURL)
	if err != nil {
		return err
	}
	reconciler, err := application.NewReconcilerWithBootstrap(
		repository, provider, egressHTTP, issuer, now, application.BootstrapConfig{
			AdvertisedEndpoint: configuration.AdvertisedEndpoint,
			EgressEndpoint:     configuration.EgressEndpoint,
			ManagementNetwork:  configuration.ManagementNetwork,
			DNSIPv4:            configuration.DNSIPv4,
		},
	)
	if err != nil {
		return err
	}
	if err := reconciler.RestoreReady(ctx); err != nil {
		return err
	}
	runner, err := reconcileworker.NewRunner(repository, reconciler, queue, time.Minute, 5*time.Second)
	if err != nil {
		return err
	}
	internalHandler, err := httpapi.NewWithReadiness(service, workService, func(checkCtx context.Context) error {
		if err := database.PingContext(checkCtx); err != nil {
			return err
		}
		if err := egressHTTP.Ready(checkCtx); err != nil {
			return fmt.Errorf("Runtime egress is not ready: %w", err)
		}
		if err := provider.Ready(checkCtx); err != nil {
			return fmt.Errorf("Docker Runtime Provider is not ready: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	runtimeServer, err := runtimeconn.NewHTTPServer(registry, 4<<20)
	if err != nil {
		return err
	}
	runtimeMux := http.NewServeMux()
	runtimeMux.HandleFunc("GET /runtime/v1/control", runtimeServer.ControlHandler)
	internalHTTP := &http.Server{
		Addr: configuration.ListenAddress, Handler: telemetry.HTTPHandler(internalHandler),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute,
	}
	runtimeHTTP := &http.Server{
		Addr: configuration.RuntimeListenAddress, Handler: runtimeMux,
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute,
	}
	registry.OpenAdmission()

	errorsChannel := make(chan error, 3)
	go func() { errorsChannel <- runner.Run(ctx) }()
	go func() { errorsChannel <- serveHTTP(internalHTTP) }()
	go func() { errorsChannel <- serveHTTP(runtimeHTTP) }()
	slog.Info("runtime controller started",
		"internal_address", configuration.ListenAddress,
		"runtime_address", configuration.RuntimeListenAddress,
	)

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errorsChannel:
	}
	registry.CloseAdmission()
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

type randomIDs struct{}

func (randomIDs) NewID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic(fmt.Sprintf("generate operation id: %v", err))
	}
	return "op-" + hex.EncodeToString(raw)
}
