package main

import (
	"context"
	"crypto/rand"
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

	"soft/antnest-platform/services/runtime-controller/internal/config"
	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/diagnostics"
	"soft/antnest-platform/services/runtime-controller/internal/observation"
	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
	platformmonitor "soft/antnest-platform/services/runtime-controller/internal/platform/monitor"
	"soft/antnest-platform/services/runtime-controller/internal/registryclient"
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

func checkHealth(lookup func(string) string) (resultErr error) {
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
	defer joinCloseError(&resultErr, "Runtime Controller status response", response.Body.Close)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime controller status returned %s", response.Status)
	}
	return nil
}

func joinCloseError(resultErr *error, resource string, closeFunc func() error) {
	if err := closeFunc(); err != nil {
		*resultErr = errors.Join(*resultErr, fmt.Errorf("close %s: %w", resource, err))
	}
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
	database, err := postgresrepository.OpenDatabase(ctx, configuration.DatabaseURL, 20, 5)
	if err != nil {
		return classified("repository", "database_connection_failed", err)
	}
	defer joinCloseError(&resultErr, "Runtime Controller database", database.Close)
	lockDatabase, err := postgresrepository.OpenDatabase(ctx, configuration.DatabaseURL, 8, 8)
	if err != nil {
		return classified("repository", "lock_database_connection_failed", err)
	}
	defer joinCloseError(&resultErr, "Runtime Controller lock database", lockDatabase.Close)
	if err := postgresrepository.Migrate(ctx, database); err != nil {
		return classified("repository", "database_migration_failed", err)
	}
	baseRepository, err := postgresrepository.New(database, lockDatabase, configuration.ObservationRetention)
	if err != nil {
		return classified("repository", "repository_initialization_failed", err)
	}
	hub := observation.NewHub()
	observationHealth := &observation.Health{}
	repository, err := observation.NewRepository(baseRepository, hub, observationHealth)
	if err != nil {
		return classified("observation", "observation_repository_initialization_failed", err)
	}
	dockerClient, err := platformdocker.NewUnixClient(configuration.DockerSocketPath)
	if err != nil {
		return classified("platform", "docker_client_initialization_failed", err)
	}
	skillVolumes, err := platformdocker.NewSkillVolumeWriter(dockerClient, configuration.SkillPreparerImage)
	if err != nil {
		return classified("skill_preparation", "skill_volume_writer_initialization_failed", err)
	}
	driver, err := platformdocker.NewDriver(dockerClient, platformdocker.Config{
		ControllerScope:    configuration.ControllerScope,
		ManagementNetwork:  configuration.ManagementNetwork,
		SystemSkillsVolume: configuration.SystemSkillsVolume,
		RuntimeOTEL:        configuration.RuntimeOTEL,
		SkillMountGate:     skillVolumes,
	})
	if err != nil {
		return classified("platform", "docker_driver_initialization_failed", err)
	}
	var skillService *control.SkillPreparationService
	var skillWorker *control.SkillPreparationWorker
	if configuration.SkillRegistryURL != "" {
		skillService, err = control.NewSkillPreparationService(baseRepository, configuration.ControllerScope)
		if err != nil {
			return classified("skill_preparation", "skill_service_initialization_failed", err)
		}
		skillService.SetReadyVerifier(baseRepository, skillVolumes)
		registry, registryErr := registryclient.New(configuration.SkillRegistryURL, configuration.SkillRegistryToken, 30*time.Second, nil)
		if registryErr != nil {
			return classified("skill_preparation", "skill_registry_client_initialization_failed", registryErr)
		}
		workerID, identityErr := newNotificationProbePayload()
		if identityErr != nil {
			return classified("skill_preparation", "skill_worker_identity_failed", identityErr)
		}
		skillWorker, err = control.NewSkillPreparationWorker(baseRepository, registry, skillVolumes, configuration.ControllerScope, workerID)
		if err != nil {
			return classified("skill_preparation", "skill_worker_initialization_failed", err)
		}
	}
	cleanupID, err := newNotificationProbePayload()
	if err != nil {
		return classified("skill_cleanup", "skill_cleanup_identity_failed", err)
	}
	skillCleanup, err := control.NewSkillCleanupWorker(baseRepository, skillVolumes, configuration.ControllerScope, cleanupID)
	if err != nil {
		return classified("skill_cleanup", "skill_cleanup_initialization_failed", err)
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
		repository, baseRepository, observationHealth, observedPlatform, verifier, time.Now,
		configuration.MutationTimeout,
		configuration.ControllerScope,
	)
	if err != nil {
		return classified("control", "control_service_initialization_failed", err)
	}
	service.SetSkillVolumeInspector(skillVolumes)
	service.SetActiveSkillSetVerifier(repository, skillVolumes)
	monitor, err := platformmonitor.New(
		observedPlatform, service, observationHealth, slog.Default(), time.Second,
		configuration.ReconciliationTimeout,
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
		err := baseRepository.ListenObservationNotifications(ctx, func() {
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
		err := monitor.RunCoordinated(ctx, baseRepository, func() {
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
	var skillHandler []rpc.SkillPreparationService
	if skillService != nil {
		skillHandler = append(skillHandler, skillService)
	}
	handler, err := rpc.NewHandler(
		service, hub, configuration.SSEHeartbeat, configuration.RPCRequestTimeout, skillHandler...,
	)
	if err != nil {
		return classified("rpc", "rpc_handler_initialization_failed", err)
	}
	handler.SetActiveSkillVerifier(service)
	legacyInventory, err := platformdocker.NewLegacyInventoryReader(
		dockerClient, "/system-skills-volume", configuration.SystemSkillsVolume, configuration.ControllerScope,
	)
	if err != nil {
		return classified("legacy_inventory", "legacy_inventory_initialization_failed", err)
	}
	handler.SetLegacyInventory(legacyInventory)
	backupRootInfo, err := os.Lstat(configuration.LegacyBackupRoot)
	if err != nil || !backupRootInfo.IsDir() {
		return classified("legacy_backup", "legacy_backup_storage_unavailable", fmt.Errorf("legacy backup mount is absent or invalid: %v", err))
	}
	if err := os.Chmod(configuration.LegacyBackupRoot, 0700); err != nil {
		return classified("legacy_backup", "legacy_backup_storage_unavailable", err)
	}
	legacyBackup, err := platformdocker.NewLegacyBackupWriter(
		dockerClient, "/system-skills-volume", configuration.LegacyBackupRoot, configuration.SystemSkillsVolume, configuration.ControllerScope,
	)
	if err != nil {
		return classified("legacy_backup", "legacy_backup_initialization_failed", err)
	}
	handler.SetLegacyBackup(legacyBackup)
	serverContext, cancelServer := context.WithCancelCause(context.WithoutCancel(ctx))
	defer cancelServer(rpc.ErrServerShutdown)
	server := &http.Server{
		Addr: configuration.ListenAddress, Handler: telemetry.HTTPHandler(handler),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: time.Minute,
		BaseContext: func(net.Listener) context.Context { return serverContext },
	}
	if err := service.Ready(ctx); err != nil {
		return classified("readiness", "startup_readiness_failed", err)
	}
	workerContext, stopWorkers := context.WithCancel(ctx)
	defer stopWorkers()
	var skillWorkerDone chan struct{}
	if skillWorker != nil {
		skillWorkerDone = make(chan struct{})
		go func() {
			defer close(skillWorkerDone)
			runSkillPreparationWorker(workerContext, skillWorker)
		}()
	}
	go runSkillCleanupWorker(workerContext, skillCleanup)
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
	stopWorkers()
	cancelServer(rpc.ErrServerShutdown)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	shutdownErr := classified("rpc", "http_shutdown_failed", server.Shutdown(shutdownCtx))
	if skillWorkerDone != nil {
		select {
		case <-skillWorkerDone:
		case <-time.After(12 * time.Second):
			return errors.Join(runErr, shutdownErr, classified("skill_preparation", "skill_worker_shutdown_timeout", context.DeadlineExceeded))
		}
	}
	return errors.Join(runErr, shutdownErr)
}

func runSkillPreparationWorker(ctx context.Context, worker *control.SkillPreparationWorker) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if _, err := worker.RunOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Error("Skill preparation round failed", "component", "skill_preparation", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runSkillCleanupWorker(ctx context.Context, worker *control.SkillCleanupWorker) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if _, err := worker.RunOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Error("Skill cleanup round failed", "component", "skill_cleanup", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
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
