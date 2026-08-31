package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"soft/antnest-platform/services/runtime-controller/internal/config"
	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/diagnostics"
	"soft/antnest-platform/services/runtime-controller/internal/observation"
	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
	platformmonitor "soft/antnest-platform/services/runtime-controller/internal/platform/monitor"
	postgresrepository "soft/antnest-platform/services/runtime-controller/internal/repository/postgres"
	"soft/antnest-platform/services/runtime-controller/internal/rpc"
	"soft/antnest-platform/services/runtime-controller/internal/runtimeclient"
	"soft/antnest-platform/services/runtime-controller/internal/telemetry"
)

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
	if err := run(ctx); err != nil {
		os.Exit(1)
	}
}

func checkHealth(lookup func(string) string) error {
	listen := strings.TrimSpace(lookup("ANTNEST_RUNTIME_CONTROLLER_LISTEN"))
	if listen == "" {
		listen = ":8080"
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("parse Runtime Controller listen address: %w", err)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/status")
	if err != nil {
		return classified("readiness", "healthcheck_transport_failed", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Runtime Controller status returned %s", response.Status)
	}
	return nil
}

func run(ctx context.Context) (resultErr error) {
	baseLogger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	telemetryRuntime, err := telemetry.Setup(ctx, baseLogger.Handler(), telemetry.Config{
		ServiceName: "runtime-controller",
	})
	if err != nil {
		resultErr = classified("telemetry", "telemetry_setup_failed", err)
		logRuntimeStopped(baseLogger, resultErr)
		return resultErr
	}
	slog.SetDefault(telemetryRuntime.Logger())
	defer func() { finishTelemetry(telemetryRuntime, resultErr) }()

	configuration, err := config.Load(os.Getenv)
	if err != nil {
		return classified("configuration", "invalid_configuration", err)
	}
	database, err := openDatabase(ctx, configuration.DatabaseURL, 20, 5)
	if err != nil {
		return classified("repository", "database_connection_failed", err)
	}
	defer database.Close()
	lockDatabase, err := openDatabase(ctx, configuration.DatabaseURL, 8, 8)
	if err != nil {
		return classified("repository", "lock_database_connection_failed", err)
	}
	defer lockDatabase.Close()
	if err := postgresrepository.Migrate(ctx, database); err != nil {
		return classified("repository", "database_migration_failed", err)
	}
	baseRepository, err := postgresrepository.New(database, lockDatabase, configuration.ObservationRetention)
	if err != nil {
		return classified("repository", "repository_initialization_failed", err)
	}
	observedRepository, err := telemetry.ObserveRepository(baseRepository, slog.Default())
	if err != nil {
		return classified("telemetry", "repository_observer_initialization_failed", err)
	}
	hub := observation.NewHub()
	observationHealth := &observation.Health{}
	repository, err := observation.NewRepository(observedRepository, hub, observationHealth)
	if err != nil {
		return classified("observation", "observation_repository_initialization_failed", err)
	}
	dockerClient, err := platformdocker.NewUnixClient(configuration.DockerSocketPath)
	if err != nil {
		return classified("platform", "docker_client_initialization_failed", err)
	}
	driver, err := platformdocker.NewDriver(dockerClient, platformdocker.Config{
		ManagementNetwork:  configuration.ManagementNetwork,
		SystemSkillsVolume: configuration.SystemSkillsVolume,
		RuntimeOTEL:        configuration.RuntimeOTEL,
	})
	if err != nil {
		return classified("platform", "docker_driver_initialization_failed", err)
	}
	observedPlatform, err := telemetry.ObservePlatform(driver, slog.Default(), configuration.Platform)
	if err != nil {
		return classified("telemetry", "platform_observer_initialization_failed", err)
	}
	verifier, err := runtimeclient.New(runtimeStatusHTTPClient(), configuration.RuntimeStatusTimeout)
	if err != nil {
		return classified("runtime_status", "runtime_verifier_initialization_failed", err)
	}
	service, err := control.NewService(
		repository, observedRepository, observationHealth, observedPlatform, verifier, time.Now,
		configuration.MutationTimeout, configuration.RuntimeReadyTimeout, configuration.RuntimePollInterval,
	)
	if err != nil {
		return classified("control", "control_service_initialization_failed", err)
	}
	monitor, err := platformmonitor.New(
		observedPlatform, service, observationHealth, slog.Default(), time.Second,
	)
	if err != nil {
		return classified("observation", "platform_monitor_initialization_failed", err)
	}
	componentErrors := make(chan error, 3)
	notificationProbe, err := newNotificationProbePayload()
	if err != nil {
		return classified("observation", "observation_notification_probe_initialization_failed", err)
	}
	notificationsReady := make(chan struct{})
	notificationProbeDelivered := make(chan struct{})
	var notificationsReadyOnce sync.Once
	var notificationProbeOnce sync.Once
	go func() {
		err := observedRepository.ListenObservationNotifications(ctx, func() {
			observationHealth.MarkNotifications(true)
			notificationsReadyOnce.Do(func() { close(notificationsReady) })
		}, func(payload string) {
			if strings.HasPrefix(payload, "readiness_probe:") {
				if payload == notificationProbe {
					notificationProbeOnce.Do(func() { close(notificationProbeDelivered) })
				}
				return
			}
			hub.Publish()
		})
		observationHealth.MarkNotifications(false)
		if err == nil && ctx.Err() == nil {
			err = errors.New("observation notification listener stopped unexpectedly")
		}
		componentErrors <- classified("observation", "observation_notification_listener_failed", err)
	}()
	select {
	case <-notificationsReady:
	case err := <-componentErrors:
		return err
	case <-ctx.Done():
		return nil
	}
	if err := baseRepository.ProbeObservationNotification(ctx, notificationProbe); err != nil {
		return classified("observation", "observation_notification_probe_failed", err)
	}
	probeTimer := time.NewTimer(5 * time.Second)
	defer probeTimer.Stop()
	select {
	case <-notificationProbeDelivered:
	case err := <-componentErrors:
		return err
	case <-probeTimer.C:
		return classified("observation", "observation_notification_probe_timeout",
			errors.New("observation notification probe was not delivered"))
	case <-ctx.Done():
		return nil
	}
	if err := baseRepository.ProbeObservationJournal(ctx); err != nil {
		return classified("observation", "observation_journal_probe_failed", err)
	}
	observationHealth.MarkJournal(true)

	monitorReady := make(chan struct{})
	var monitorReadyOnce sync.Once
	go func() {
		err := monitor.RunCoordinated(ctx, observedRepository, func() {
			monitorReadyOnce.Do(func() { close(monitorReady) })
		})
		observationHealth.MarkMonitor(false)
		if err == nil && ctx.Err() == nil {
			err = errors.New("platform observation monitor stopped unexpectedly")
		}
		componentErrors <- classified("observation", "platform_monitor_failed", err)
	}()
	select {
	case <-monitorReady:
	case err := <-componentErrors:
		return err
	case <-ctx.Done():
		return nil
	}
	handler, err := rpc.NewHandler(service, hub, configuration.SSEHeartbeat)
	if err != nil {
		return classified("rpc", "rpc_handler_initialization_failed", err)
	}
	server := &http.Server{
		Addr: configuration.ListenAddress, Handler: telemetry.HTTPHandler(handler),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute,
	}
	if err := service.Ready(ctx); err != nil {
		return classified("readiness", "startup_readiness_failed", err)
	}
	go func() { componentErrors <- classified("rpc", "http_server_failed", serveHTTP(server)) }()
	slog.Info("Runtime Controller started",
		"listen_address", configuration.ListenAddress,
		"platform", configuration.Platform,
	)
	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-componentErrors:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return errors.Join(runErr, classified("rpc", "http_shutdown_failed", server.Shutdown(shutdownCtx)))
}

type telemetryLifecycle interface {
	Logger() *slog.Logger
	Shutdown(context.Context) error
}

func finishTelemetry(runtime telemetryLifecycle, resultErr error) {
	logger := runtime.Logger()
	if resultErr != nil {
		logRuntimeStopped(logger, resultErr)
	}
	if shutdownErr := runtime.Shutdown(context.Background()); shutdownErr != nil {
		logger.Error("Runtime Controller telemetry shutdown failed",
			"component", "telemetry", "error_class", "telemetry_shutdown_error")
	}
}

func logRuntimeStopped(logger *slog.Logger, err error) {
	component, errorClass := failureClassification(err)
	logger.Error("Runtime Controller stopped",
		"component", component, "error_class", errorClass, "error", safeDiagnostic(err))
}

func newNotificationProbePayload() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate observation notification probe: %w", err)
	}
	return "readiness_probe:" + hex.EncodeToString(raw), nil
}

type classifiedError struct {
	component  string
	errorClass string
	cause      error
}

func (e *classifiedError) Error() string { return e.cause.Error() }
func (e *classifiedError) Unwrap() error { return e.cause }

func classified(component, errorClass string, err error) error {
	if err == nil {
		return nil
	}
	return &classifiedError{component: component, errorClass: errorClass, cause: err}
}

func failureClassification(err error) (string, string) {
	var failure *classifiedError
	if errors.As(err, &failure) {
		return failure.component, failure.errorClass
	}
	return "runtime_controller", "unexpected_error"
}

func safeDiagnostic(err error) string {
	return diagnostics.Message(err)
}

func openDatabase(
	ctx context.Context, databaseURL string, maxOpenConnections, maxIdleConnections int,
) (*sql.DB, error) {
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open Runtime Controller database: %w", err)
	}
	database.SetMaxOpenConns(maxOpenConnections)
	database.SetMaxIdleConns(maxIdleConnections)
	database.SetConnMaxLifetime(30 * time.Minute)
	if err := database.PingContext(ctx); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("connect Runtime Controller database: %w", err)
	}
	return database, nil
}

func runtimeStatusHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		ResponseHeaderTimeout: 10 * time.Second,
	}}
}

func serveHTTP(server *http.Server) error {
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
