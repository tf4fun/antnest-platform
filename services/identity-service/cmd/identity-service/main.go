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

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/config"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcclient"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/rpc"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/server"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
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
		if err := checkHealth(os.LookupEnv); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.LookupEnv); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error(
			"Identity Service stopped with an error",
			"error_class", serviceFailureClass(err),
		)
		os.Exit(1)
	}
}

func checkHealth(lookup serviceauth.LookupEnv) (resultErr error) {
	listenValue, _ := lookup("ANTNEST_IDENTITY_LISTEN")
	listenAddress := strings.TrimSpace(listenValue)
	if listenAddress == "" {
		listenAddress = ":8080"
	}
	_, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return fmt.Errorf("parse Identity listen address: %w", err)
	}
	tlsConfig, err := serviceauth.HealthTLS("identity-service", lookup)
	if err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsConfig
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 2 * time.Second, Transport: transport}
	scheme := "http"
	if tlsConfig != nil {
		scheme = "https"
	}
	response, err := client.Get(scheme + "://127.0.0.1:" + port + "/status")
	if err != nil {
		return fmt.Errorf("request Identity status: %w", err)
	}
	defer joinCloseError(&resultErr, "Identity status response", response.Body.Close)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("identity status returned %s", response.Status)
	}
	return nil
}

func joinCloseError(resultErr *error, resource string, closeFunc func() error) {
	if err := closeFunc(); err != nil {
		*resultErr = errors.Join(*resultErr, fmt.Errorf("close %s: %w", resource, err))
	}
}

func run(ctx context.Context, lookup serviceauth.LookupEnv) (resultErr error) {
	getenv := func(key string) string { value, _ := lookup(key); return value }
	cfg, err := config.Load(getenv)
	if err != nil {
		return classifyFailure("configuration", err)
	}
	authentication, err := serviceauth.LoadConfig("identity-service", lookup)
	if err != nil {
		return classifyFailure("configuration", err)
	}
	signing, err := callercontext.LoadSigning(lookup)
	if err != nil {
		return classifyFailure("configuration", err)
	}
	telemetryRuntime, err := telemetry.Setup(ctx, slog.NewJSONHandler(os.Stdout, nil), telemetry.Config{
		ServiceVersion: version, Environment: getenv("ANTNEST_ENVIRONMENT"),
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

	poolConfig, err := repository.ParsePoolConfig(cfg.DatabaseURL)
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
	store, err := repository.New(pool, identityid.MustNew, time.Now)
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
		Transport: telemetry.NewHTTPTransport(http.DefaultTransport),
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
		RedirectURI: cfg.PublicBaseURL + "/protocol/oidc/callback",
		SessionTTL:  cfg.OIDCSessionTTL, TokenTTL: cfg.TokenTTL,
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
	authority, err := callercontext.NewAuthority(callercontext.Config{KID: signing.KID, PrivateKey: signing.PrivateKey, Keys: signing.Keys, Repository: store.LocalAuth(), Now: time.Now, NewID: func() string { return identityid.MustNew("authtoken") }})
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	rpcHandler, err := rpc.NewHandler(rpc.Dependencies{
		Directory: directoryService, LocalAuth: localAuthService, OIDC: oidcService, SCIM: scimService,
		Authentication: authentication.Receiver, CallerContext: authority,
	})
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	scimHandler, err := scim.NewHTTPHandler(scimService, cfg.PublicBaseURL)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	handler, readiness, err := server.NewHandler(store, rpcHandler, scimHandler, authentication.Receiver)
	if err != nil {
		return classifyFailure("service_composition", err)
	}
	httpServer := &http.Server{
		Addr: cfg.ListenAddress, Handler: telemetry.HTTPHandler(handler, logger),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: 2 * time.Minute, IdleTimeout: 90 * time.Second,
		MaxHeaderBytes: 1 << 20,
		TLSConfig:      authentication.ServerTLS,
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		return classifyFailure("listener", err)
	}
	readiness.Set(true)
	logger.Info("Identity Service is ready", "listen_address", cfg.ListenAddress)
	serverErrors := make(chan error, 1)
	go func() {
		if authentication.ServerTLS != nil {
			serverErrors <- httpServer.ServeTLS(listener, "", "")
		} else {
			serverErrors <- httpServer.Serve(listener)
		}
	}()
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
		closeErr := httpServer.Close()
		resultErr = errors.Join(
			resultErr,
			classifyFailure("http_shutdown", err),
			classifyFailure("http_close", closeErr),
		)
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
