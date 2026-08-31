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

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"soft/antnest-platform/services/identity-service/internal/config"
	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/identityid"
	"soft/antnest-platform/services/identity-service/internal/localauth"
	"soft/antnest-platform/services/identity-service/internal/oidcclient"
	"soft/antnest-platform/services/identity-service/internal/oidcflow"
	"soft/antnest-platform/services/identity-service/internal/repository"
	"soft/antnest-platform/services/identity-service/internal/rpc"
	"soft/antnest-platform/services/identity-service/internal/scim"
	"soft/antnest-platform/services/identity-service/internal/server"
	"soft/antnest-platform/services/identity-service/internal/telemetry"
)

var version = "dev"

type serviceFailure struct {
	class string
	cause error
}

func (e *serviceFailure) Error() string {
	return "identity service " + e.class + ": " + e.cause.Error()
}
func (e *serviceFailure) Unwrap() error { return e.cause }

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
			"Identity Service stopped with an error",
			"error_class", serviceFailureClass(err),
		)
		os.Exit(1)
	}
}

func checkHealth(lookup func(string) string) error {
	listenAddress := strings.TrimSpace(lookup("ANTNEST_IDENTITY_LISTEN"))
	if listenAddress == "" {
		listenAddress = ":8080"
	}
	_, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return fmt.Errorf("parse Identity listen address: %w", err)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/status")
	if err != nil {
		return fmt.Errorf("request Identity status: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Identity status returned %s", response.Status)
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

	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return classifyFailure("database_configuration", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return classifyFailure("database_startup", err)
	}
	defer pool.Close()
	if err := repository.ApplyMigrations(ctx, pool); err != nil {
		return classifyFailure("database_migration", err)
	}
	store, err := repository.New(pool, identityid.MustNew)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	if err := initializeIdentityFacts(ctx, cfg, store); err != nil {
		return classifyFailure("identity_bootstrap", err)
	}
	interrupted, err := store.FailExpiredOIDCSessions(ctx, time.Now().UTC())
	if err != nil {
		return classifyFailure("oidc_recovery", err)
	}
	if interrupted > 0 {
		logger.Warn("Expired OIDC callbacks were terminalized", "session_count", interrupted)
	}

	secretBox, err := credentials.NewSecretBox(cfg.EncryptionKey)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	outboundHTTP := &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		Timeout:   cfg.HTTPTimeout,
	}
	federation, err := oidcclient.New(outboundHTTP)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	directoryService := directory.NewService(store.Directory(), identityid.MustNew, time.Now)
	localAuthService, err := localauth.NewService(store.LocalAuth(), identityid.MustNew, time.Now, cfg.TokenTTL)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	oidcService, err := oidcflow.NewService(oidcflow.Config{
		Repository: store.OIDC(), Federation: federation, SecretBox: secretBox,
		NewID: identityid.MustNew, NewOpaque: credentials.NewOpaqueToken, Now: time.Now,
		SessionTTL: cfg.OIDCSessionTTL, TokenTTL: cfg.TokenTTL,
	})
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	scimService, err := scim.NewService(scim.Config{
		Repository: store.SCIM(), NewID: identityid.MustNew,
		NewOpaque: credentials.NewOpaqueToken, Now: time.Now,
	})
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	rpcHandler, err := rpc.NewHandler(rpc.Dependencies{
		Directory: directoryService, LocalAuth: localAuthService, OIDC: oidcService, SCIM: scimService,
	})
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	scimHandler, err := scim.NewHTTPHandler(scimService, cfg.PublicBaseURL)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	handler, readiness, err := server.NewHandler(store, rpcHandler, scimHandler)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	httpServer := &http.Server{
		Addr: cfg.ListenAddress, Handler: telemetry.HTTPHandler(handler, logger),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: 2 * time.Minute, IdleTimeout: 90 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		return classifyFailure("listener", err)
	}
	readiness.Set(true)
	logger.Info("Identity Service is ready", "listen_address", cfg.ListenAddress)
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- httpServer.Serve(listener) }()
	select {
	case <-ctx.Done():
	case serveErr := <-serverErrors:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			resultErr = classifyFailure("http_serve", serveErr)
		}
	}
	readiness.Set(false)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		httpServer.Close()
		resultErr = errors.Join(resultErr, classifyFailure("http_shutdown", err))
	}
	return resultErr
}

func initializeIdentityFacts(ctx context.Context, cfg config.Config, store *repository.Store) error {
	if !cfg.Bootstrap.Enabled() {
		return nil
	}
	slug, err := domain.NormalizeSlug(cfg.Bootstrap.OrganizationSlug)
	if err != nil {
		return fmt.Errorf("bootstrap organization slug: %w", err)
	}
	name, err := domain.NormalizeDisplayName(cfg.Bootstrap.OrganizationName)
	if err != nil {
		return fmt.Errorf("bootstrap organization name: %w", err)
	}
	email, err := domain.NormalizeEmail(cfg.Bootstrap.AdminEmail)
	if err != nil {
		return fmt.Errorf("bootstrap administrator email: %w", err)
	}
	passwordHash, err := credentials.HashPassword(cfg.Bootstrap.AdminPassword)
	if err != nil {
		return fmt.Errorf("bootstrap administrator password: %w", err)
	}
	_, err = store.Bootstrap(ctx, repository.BootstrapInput{
		OrganizationSlug: slug, OrganizationName: name, AdminEmail: email,
		AdminDisplayName: "Antnest Administrator", PasswordHash: passwordHash, Now: time.Now().UTC(),
	})
	return err
}
