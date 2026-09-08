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

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/config"
	"soft/antnest-platform/services/agent-controller/internal/credentials"
	"soft/antnest-platform/services/agent-controller/internal/egressclient"
	"soft/antnest-platform/services/agent-controller/internal/identityclient"
	"soft/antnest-platform/services/agent-controller/internal/repository/postgres"
	"soft/antnest-platform/services/agent-controller/internal/runtimeclient"
	"soft/antnest-platform/services/agent-controller/internal/server"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

var version = "dev"

type serviceFailure struct {
	class string
	cause error
}

func (failure *serviceFailure) Error() string {
	return "agent controller " + failure.class + ": " + failure.cause.Error()
}

func (failure *serviceFailure) Unwrap() error { return failure.cause }

func classifyFailure(class string, err error) error {
	if err == nil {
		return nil
	}
	return &serviceFailure{class: class, cause: err}
}

func serviceFailureClass(err error) string {
	var failure *serviceFailure
	if errors.As(err, &failure) {
		return failure.class
	}
	return "service_failure"
}

func serviceFailureDetail(err error) string {
	var failure *serviceFailure
	if errors.As(err, &failure) && failure.class == "telemetry_startup" {
		return failure.cause.Error()
	}
	return ""
}

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
		attributes := []any{"error_class", serviceFailureClass(err)}
		if detail := serviceFailureDetail(err); detail != "" {
			attributes = append(attributes, "detail", detail)
		}
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("Agent Controller stopped with an error", attributes...)
		os.Exit(1)
	}
}

func checkHealth(lookup func(string) string) (resultErr error) {
	return checkHealthWithClient(lookup, &http.Client{Timeout: 2 * time.Second})
}

func checkHealthWithClient(lookup func(string) string, client *http.Client) (resultErr error) {
	listenAddress := strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_LISTEN"))
	if listenAddress == "" {
		listenAddress = ":8080"
	}
	_, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return fmt.Errorf("parse Agent Controller listen address: %w", err)
	}
	response, err := client.Get("http://127.0.0.1:" + port + "/status")
	if err != nil {
		return fmt.Errorf("request Agent Controller status: %w", err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close Agent Controller status response: %w", err))
		}
	}()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("agent controller status returned %s", response.Status)
	}
	return nil
}

func run(ctx context.Context, lookup func(string) string) (resultErr error) {
	cfg, err := config.Load(lookup)
	if err != nil {
		return classifyFailure("configuration", err)
	}
	telemetryRuntime, err := telemetry.Setup(ctx, slog.NewJSONHandler(os.Stdout, nil), telemetry.Config{
		ServiceVersion: version, Environment: lookup("ANTNEST_ENVIRONMENT"),
	})
	if err != nil {
		return classifyFailure("telemetry_startup", err)
	}
	defer func() {
		resultErr = errors.Join(
			resultErr,
			classifyFailure("telemetry_shutdown", telemetryRuntime.Shutdown(context.Background())),
		)
	}()
	logger := telemetryRuntime.Logger()
	slog.SetDefault(logger)

	repository, err := postgres.Open(
		ctx, cfg.DatabaseURL,
		postgres.WithEventAppendObserver(telemetry.RecordAgentEventAppend),
	)
	if err != nil {
		return classifyFailure("database_startup", err)
	}
	defer repository.Close()
	if err := repository.Migrate(ctx); err != nil {
		return classifyFailure("database_migration", err)
	}
	eventNotifier, err := postgres.OpenEventNotifier(
		ctx, cfg.DatabaseURL,
		postgres.WithEventNotifierObserver(func(state string) {
			telemetry.RecordAgentEventNotifierTransition(state)
			if state == "disconnected" {
				logger.Warn("Agent event notifier disconnected")
				return
			}
			logger.Info("Agent event notifier reconnected")
		}),
	)
	if err != nil {
		return classifyFailure("event_notifier_startup", err)
	}
	defer eventNotifier.Close()
	secretBox, err := credentials.NewSecretBox(cfg.EncryptionKey)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	observedStore, err := telemetry.ObserveCatalogStore(repository, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	observedLifecycleStore, err := telemetry.ObserveLifecycleStore(repository, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	observedRecoveryStore, err := telemetry.ObserveLifecycleRecoveryStore(repository, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	observedRunStore, err := telemetry.ObserveRunStore(repository, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	observedAgentQueryStore, err := telemetry.ObserveAgentQueryStore(repository, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	observedAgentEventStore, err := telemetry.ObserveAgentEventStore(repository, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	egress, err := egressclient.New(cfg.RuntimeEgressURL, cfg.DependencyTimeout, nil)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	runtime, err := runtimeclient.New(cfg.RuntimeControllerURL, cfg.DependencyTimeout, nil)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	runtimeObservationWorker, err := application.NewRuntimeObservationWorker(
		runtime, repository, cfg.ObservationPollInterval, logger,
	)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	identity, err := identityclient.New(cfg.IdentityServiceURL, cfg.DependencyTimeout, nil)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	catalog := application.NewCatalogService(observedStore, secretBox, runtime, systemClock{})
	lifecycle := application.NewLifecycleServiceWithDrainTimeout(
		observedStore, observedLifecycleStore, egress, runtime, systemClock{}, cfg.DrainTimeout,
		application.WithIdentityDirectory(identity),
	)
	observedRevocations, err := telemetry.ObserveIdentityRevocationStore(repository, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	identityWorker, err := application.NewIdentityRevocationWorker(identity, observedRevocations, lifecycle, cfg.IdentityRevocationPollInterval, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	recoveryInstrumentation, err := telemetry.ObserveLifecycleRecoveryAttempt(logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	hostname, err := os.Hostname()
	if err != nil {
		return classifyFailure("service_composition", fmt.Errorf("resolve recovery worker hostname: %w", err))
	}
	recoveryWorkerID, err := lifecycleRecoveryWorkerID(hostname, os.Getpid())
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	recoveryWorker, err := application.NewLifecycleRecoveryWorker(
		observedRecoveryStore, lifecycle, recoveryInstrumentation,
		application.LifecycleRecoveryWorkerConfig{
			WorkerID: recoveryWorkerID, PollInterval: cfg.RecoveryPollInterval,
			AttemptTimeout: cfg.RecoveryAttemptTimeout,
			LeaseDuration:  cfg.RecoveryLeaseDuration, RetryMax: cfg.RecoveryRetryMax,
		},
	)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	runs := application.NewRunService(
		observedRunStore, secretBox, systemClock{}, cfg.RunAdmissionTTL,
		application.WithRunIdentityDirectory(identity),
	)
	queries := application.NewAgentQueryService(observedAgentQueryStore)
	events := application.NewEventService(observedAgentEventStore, eventNotifier, observedAgentQueryStore)
	handler, err := server.NewHandler(
		catalog, lifecycle, runs, queries, events, repository.Ping,
	)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	httpServer := &http.Server{
		Addr: cfg.ListenAddress, Handler: telemetry.HTTPHandler(handler, logger),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: cfg.DependencyTimeout, IdleTimeout: 90 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		return classifyFailure("listener", err)
	}
	logger.Info("Agent Controller is ready", "listen_address", cfg.ListenAddress)
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- httpServer.Serve(listener) }()
	recoveryCtx, stopRecovery := context.WithCancel(ctx)
	recoveryErrors := make(chan error, 1)
	go func() { recoveryErrors <- recoveryWorker.Run(recoveryCtx) }()
	observationCtx, stopObservation := context.WithCancel(ctx)
	observationStopped := make(chan struct{})
	go func() {
		defer close(observationStopped)
		runtimeObservationWorker.Run(observationCtx)
	}()
	identityStopped := make(chan struct{})
	go func() {
		defer close(identityStopped)
		identityWorker.Run(observationCtx)
	}()
	recoveryStopped := false
	select {
	case <-ctx.Done():
	case serveErr := <-serverErrors:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			resultErr = classifyFailure("http_serve", serveErr)
		}
	case recoveryErr := <-recoveryErrors:
		recoveryStopped = true
		if recoveryErr != nil {
			resultErr = classifyFailure("lifecycle_recovery", recoveryErr)
		} else if ctx.Err() == nil {
			resultErr = classifyFailure(
				"lifecycle_recovery", errors.New("lifecycle recovery worker stopped unexpectedly"),
			)
		}
	}
	stopRecovery()
	stopObservation()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	resultErr = errors.Join(
		resultErr,
		shutdownHTTPAndRecovery(shutdownCtx, httpServer, recoveryErrors, recoveryStopped),
		waitForRuntimeObservationWorker(shutdownCtx, observationStopped),
		waitForIdentityWorker(shutdownCtx, identityStopped),
	)
	return resultErr
}

func waitForIdentityWorker(ctx context.Context, stopped <-chan struct{}) error {
	select {
	case <-stopped:
		return nil
	case <-ctx.Done():
		return classifyFailure("identity_offboarding_shutdown", ctx.Err())
	}
}

func waitForRuntimeObservationWorker(ctx context.Context, stopped <-chan struct{}) error {
	select {
	case <-stopped:
		return nil
	case <-ctx.Done():
		return classifyFailure("runtime_observation_shutdown", ctx.Err())
	}
}

func shutdownHTTPAndRecovery(
	ctx context.Context,
	httpServer *http.Server,
	recoveryErrors <-chan error,
	recoveryStopped bool,
) error {
	httpStopped := make(chan error, 1)
	go func() { httpStopped <- httpServer.Shutdown(ctx) }()
	waitingHTTP := true
	waitingRecovery := !recoveryStopped
	var result error
	for waitingHTTP || waitingRecovery {
		select {
		case err := <-httpStopped:
			waitingHTTP = false
			if err != nil {
				result = errors.Join(
					result, classifyFailure("http_shutdown", err),
					classifyFailure("http_close", httpServer.Close()),
				)
			}
		case err := <-recoveryErrors:
			waitingRecovery = false
			if err != nil && !errors.Is(err, context.Canceled) {
				result = errors.Join(
					result, classifyFailure("lifecycle_recovery_shutdown", err),
				)
			}
		case <-ctx.Done():
			if waitingHTTP {
				result = errors.Join(
					result, classifyFailure("http_shutdown", ctx.Err()),
					classifyFailure("http_close", httpServer.Close()),
				)
			}
			if waitingRecovery {
				result = errors.Join(
					result, classifyFailure("lifecycle_recovery_shutdown", ctx.Err()),
				)
			}
			return result
		}
	}
	return result
}

func lifecycleRecoveryWorkerID(hostname string, pid int) (string, error) {
	hostname = strings.TrimSpace(hostname)
	if hostname == "" || pid <= 0 {
		return "", fmt.Errorf("recovery worker identity requires hostname and positive pid")
	}
	return fmt.Sprintf("%s:%d", hostname, pid), nil
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }
