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

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/config"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/egressclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/identityclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/orchestration"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/outbound"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/providerdiscovery"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/registryclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/repository/postgres"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/runtimeclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/server"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
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
		if err := checkHealth(os.LookupEnv); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.LookupEnv); err != nil {
		attributes := []any{"error_class", serviceFailureClass(err)}
		if detail := serviceFailureDetail(err); detail != "" {
			attributes = append(attributes, "detail", detail)
		}
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("Agent Controller stopped with an error", attributes...)
		os.Exit(1)
	}
}

func checkHealth(lookup serviceauth.LookupEnv) (resultErr error) {
	tlsConfig, err := serviceauth.HealthTLS("agent-controller", lookup)
	if err != nil {
		return fmt.Errorf("healthcheck transport configuration is invalid")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy, transport.TLSClientConfig = nil, tlsConfig
	defer transport.CloseIdleConnections()
	return checkHealthWithClient(lookup, &http.Client{Timeout: 2 * time.Second, Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }})
}

func checkHealthWithClient(lookup serviceauth.LookupEnv, client *http.Client) (resultErr error) {
	rawAddress, _ := lookup("ANTNEST_AGENT_CONTROLLER_LISTEN")
	listenAddress := strings.TrimSpace(rawAddress)
	if listenAddress == "" {
		listenAddress = ":8080"
	}
	_, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return fmt.Errorf("parse Agent Controller listen address: %w", err)
	}
	scheme := "http"
	if _, present := lookup("ANTNEST_TLS_CA_FILE"); present {
		scheme = "https"
	}
	response, err := client.Get(scheme + "://127.0.0.1:" + port + "/status")
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

func run(ctx context.Context, environment serviceauth.LookupEnv) (resultErr error) {
	cfg, err := config.Load(environment)
	if err != nil {
		return classifyFailure("configuration", err)
	}
	defer cfg.Authentication.CloseIdleConnections()
	lookup := func(key string) string { value, _ := environment(key); return value }
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
	egress, err := egressclient.New(cfg.RuntimeEgressURL, cfg.DependencyTimeout, cfg.Authentication.HTTPClient())
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	runtime, err := runtimeclient.New(cfg.RuntimeControllerURL, cfg.DependencyTimeout, cfg.Authentication.HTTPClient())
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	runtimeObservationWorker, err := application.NewRuntimeObservationWorker(
		runtime, repository, cfg.ObservationPollInterval, logger,
	)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	identity, err := identityclient.New(cfg.IdentityServiceURL, cfg.DependencyTimeout, cfg.Authentication.HTTPClient())
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	providerPolicy := outbound.NewPolicy(cfg.ProviderAllowPrivateEndpoints)
	providerDiscovery := providerdiscovery.New(cfg.DependencyTimeout, providerPolicy)
	defer providerDiscovery.CloseIdleConnections()
	catalogOptions := []application.CatalogOption{application.WithProviderCredentialReader(repository, secretBox),
		application.WithProviderDiscovery(providerPolicy, providerDiscovery), application.WithProviderRequestTimeout(cfg.DependencyTimeout)}
	if cfg.SkillRegistryURL != "" {
		registry, err := registryclient.New(cfg.SkillRegistryURL, cfg.DependencyTimeout, cfg.Authentication)
		if err != nil {
			return classifyFailure("service_composition", err)
		}
		catalogOptions = append(catalogOptions, application.WithSkillVersionResolver(registry))
	}
	catalog := application.NewCatalogService(repository, secretBox, systemClock{}, catalogOptions...)
	execution, executionWorker, err := configureExecutionPublication(repository, cfg, secretBox, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	lifecycle := application.NewLifecycleServiceWithDrainTimeout(
		repository, repository, egress, runtime, systemClock{}, cfg.DrainTimeout,
		application.WithIdentityDirectory(identity),
		application.WithLifecycleExecution(execution),
		application.WithSkillPreparation(repository, runtime),
	)
	queries := application.NewAgentQueryService(repository)
	events := application.NewEventService(repository, eventNotifier, repository)
	workflowClient, closeWorkflowClient, err := orchestration.Open(ctx, cfg.TemporalAddress, logger)
	if err != nil {
		return classifyFailure("workflow_startup", err)
	}
	defer closeWorkflowClient()
	workflowWorker := orchestration.NewWorker(workflowClient, lifecycle, cfg.ShutdownTimeout)
	if err := workflowWorker.Start(); err != nil {
		return classifyFailure("workflow_worker_startup", err)
	}
	defer workflowWorker.Stop()
	commands := orchestration.NewService(lifecycle, workflowClient)
	identityWorker, err := application.NewIdentityRevocationWorker(identity, repository, commands, cfg.IdentityRevocationPollInterval, logger)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	jwksClient := cfg.Authentication.HTTPClient()
	jwksClient.Timeout = 5 * time.Second
	verifier, err := callercontext.NewVerifier(cfg.IdentityServiceURL, jwksClient, 5*time.Second)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	security := server.Security{Authentication: cfg.Authentication.Config.Receiver, CallerContext: verifier}
	handler, err := server.NewHandler(
		catalog, commands, application.NewAgentConfigurationService(repository, identity, systemClock{}), queries, events,
		application.NewNetworkPolicyService(repository, egress), repository.Ping, security,
	)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	handler, err = server.WithSkillLearningPolicyRoutes(handler, application.NewSkillLearningPolicyService(repository, identity), security)
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
	if cfg.Authentication.Config.ServerTLS != nil {
		listener = tls.NewListener(listener, cfg.Authentication.Config.ServerTLS)
	}
	logger.Info("Agent Controller is ready", "listen_address", cfg.ListenAddress)
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- httpServer.Serve(listener) }()
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
	executionStopped := make(chan struct{})
	go func() {
		defer close(executionStopped)
		executionWorker.Run(observationCtx)
	}()
	select {
	case <-ctx.Done():
	case serveErr := <-serverErrors:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			resultErr = classifyFailure("http_serve", serveErr)
		}
	}
	stopObservation()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	resultErr = errors.Join(
		resultErr,
		shutdownHTTP(shutdownCtx, httpServer),
		waitForRuntimeObservationWorker(shutdownCtx, observationStopped),
		waitForIdentityWorker(shutdownCtx, identityStopped),
		waitForExecutionPublication(shutdownCtx, executionStopped),
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

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

func shutdownHTTP(ctx context.Context, server *http.Server) error {
	if err := server.Shutdown(ctx); err != nil {
		return errors.Join(classifyFailure("http_shutdown", err), classifyFailure("http_close", server.Close()))
	}
	return nil
}
