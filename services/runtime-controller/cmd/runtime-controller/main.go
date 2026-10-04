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
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/config"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/diagnostics"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	platformdocker "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
	platformmonitor "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/monitor"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/registryclient"
	postgresrepository "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository/postgres"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/rpc"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/runtimeclient"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

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
	if err := run(ctx); err != nil {
		os.Exit(1)
	}
}

func checkHealth(lookup serviceauth.LookupEnv) (resultErr error) {
	listen, _ := lookup("ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN")
	listen = strings.TrimSpace(listen)
	if listen == "" {
		listen = "127.0.0.1:8082"
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("parse Runtime Controller listen address: %w", err)
	}
	address, err := netip.ParseAddr(host)
	if err != nil || !address.IsLoopback() {
		return errors.New("health listener must be a loopback IP")
	}
	tlsConfig, err := serviceauth.HealthTLS("runtime-controller", lookup)
	if err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy, transport.TLSClientConfig = nil, tlsConfig
	defer transport.CloseIdleConnections()
	scheme := "http"
	if tlsConfig != nil {
		scheme = "https"
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(scheme + "://" + net.JoinHostPort(host, port) + "/status")
	if err != nil {
		return classified("readiness", "healthcheck_transport_failed", err)
	}
	defer joinCloseError(&resultErr, "Runtime Controller status response", response.Body.Close)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime controller status returned %s", response.Status)
	}
	return nil
}

type startupReadinessService interface {
	Status(context.Context) (control.Readiness, error)
}

func checkStartupReadiness(ctx context.Context, service startupReadinessService) error {
	status, err := service.Status(ctx)
	if err != nil {
		return err
	}
	// The first monitor handshake has already happened. A later flap belongs to
	// HTTP readiness and background recovery, not fatal startup supervision.
	if !status.LocalReady() {
		return errors.New("local Runtime Controller initialization is not ready")
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

	configuration, err := config.Load(os.LookupEnv)
	if err != nil {
		return classified("configuration", "invalid_configuration", err)
	}
	defer configuration.Authentication.CloseIdleConnections()
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
	instanceVolumes, err := platformdocker.NewInstanceVolumeWriter(dockerClient, configuration.SkillPreparerImage, configuration.InstanceCredentials, configuration.ControllerScope)
	if err != nil {
		return classified("instance_authentication", "instance_volume_initialization_failed", err)
	}
	senders, err := instanceauth.NewSender("", configuration.InstanceCredentials)
	if err != nil {
		return classified("instance_authentication", "instance_sender_initialization_failed", err)
	}
	defer joinCloseError(&resultErr, "Runtime instance sender files", senders.Close)
	driver, err := platformdocker.NewDriver(dockerClient, platformdocker.Config{
		AllowedImages:         configuration.AllowedImages,
		ControllerScope:       configuration.ControllerScope,
		ManagementNetwork:     configuration.ManagementNetwork,
		SystemSkillsVolume:    configuration.SystemSkillsVolume,
		RuntimeOTEL:           configuration.RuntimeOTEL,
		SkillMountGate:        skillVolumes,
		InstanceMountGate:     instanceVolumes,
		RuntimeAuthentication: configuration.RuntimeAuthentication,
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
		registry, registryErr := registryclient.New(configuration.SkillRegistryURL, 30*time.Second, configuration.Authentication)
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
	verifier, err := runtimeclient.NewAuthenticated(runtimeStatusHTTPClient(), configuration.RuntimeStatusTimeout, func(ctx context.Context, inspection deployment.Inspection) (string, error) {
		creator, err := baseRepository.GenerationOperation(ctx, inspection.RuntimeKey())
		if err != nil || creator.SpecDigest != inspection.SpecDigest || creator.InstanceAuthentication == nil {
			return "", control.ErrConnectionUnavailable
		}
		return senders.Install(instanceauth.Identity{Scope: configuration.ControllerScope, AgentID: inspection.AgentID, Generation: inspection.Generation}, creator.InstanceAuthentication, "runtime-controller")
	})
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
	if err := service.SetMaintenanceVerifiers(configuration.MaintenanceVerifiers); err != nil {
		return classified("control", "maintenance_verifier_initialization_failed", err)
	}
	if err := service.SetInstanceCredentials(configuration.ControllerScope, configuration.InstanceCredentials); err != nil {
		return classified("instance_authentication", "instance_issuer_initialization_failed", err)
	}
	service.SetSkillVolumeInspector(skillVolumes)
	monitor, err := platformmonitor.New(
		observedPlatform, service, observationHealth, slog.Default(), config.MonitorRetryDelay,
		configuration.MonitorMaxRetryDelay,
		configuration.ReconciliationTimeout,
	)
	if err != nil {
		return classified("observation", "platform_monitor_initialization_failed", err)
	}
	componentErrors := make(chan error, 4)
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
		service, hub, configuration.SSEHeartbeat, configuration.RPCRequestTimeout, rpc.Security{Authentication: configuration.Authentication.Config.Receiver}, skillHandler...,
	)
	if err != nil {
		return classified("rpc", "rpc_handler_initialization_failed", err)
	}
	serverContext, cancelServer := context.WithCancelCause(context.WithoutCancel(ctx))
	defer cancelServer(rpc.ErrServerShutdown)
	server := &http.Server{
		Addr: configuration.ListenAddress, Handler: telemetry.HTTPHandler(handler),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: time.Minute,
		BaseContext: func(net.Listener) context.Context { return serverContext },
		TLSConfig:   configuration.Authentication.Config.ServerTLS,
	}
	healthServer := &http.Server{Addr: configuration.HealthListenAddress, Handler: handler.HealthHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: time.Minute, TLSConfig: configuration.Authentication.Config.ServerTLS}
	if err := checkStartupReadiness(ctx, service); err != nil {
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
	go func() {
		componentErrors <- classified("readiness", "http_health_server_failed", serveHTTP(healthServer))
	}()
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
	shutdownErr = errors.Join(shutdownErr, classified("readiness", "http_health_shutdown_failed", healthServer.Shutdown(shutdownCtx)))
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
	var err error
	if server.TLSConfig != nil {
		err = server.ListenAndServeTLS("", "")
	} else {
		err = server.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
