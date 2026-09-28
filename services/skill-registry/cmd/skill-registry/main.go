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

	"soft/antnest-platform/services/skill-registry/internal/registry"
)

type config struct {
	listenAddress string
	databaseURL   string
	apiToken      string
}

func loadConfig(lookup func(string) string) (config, error) {
	value := config{
		listenAddress: strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_LISTEN")),
		databaseURL:   strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_DATABASE_URL")),
		apiToken:      lookup("ANTNEST_SKILL_REGISTRY_API_TOKEN"),
	}
	if value.listenAddress == "" {
		value.listenAddress = ":8080"
	}
	if _, _, err := net.SplitHostPort(value.listenAddress); err != nil {
		return config{}, fmt.Errorf("invalid Registry listen address")
	}
	if value.databaseURL == "" {
		return config{}, fmt.Errorf("ANTNEST_SKILL_REGISTRY_DATABASE_URL is required")
	}
	if len(value.apiToken) < 32 || strings.TrimSpace(value.apiToken) != value.apiToken {
		return config{}, fmt.Errorf("ANTNEST_SKILL_REGISTRY_API_TOKEN must be at least 32 non-whitespace bytes")
	}
	return value, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		if err := healthcheck(os.Getenv); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv); err != nil {
		slog.Error("Skill Registry stopped", "error", err.Error())
		os.Exit(1)
	}
}

func healthcheck(lookup func(string) string) error {
	address := strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_LISTEN"))
	if address == "" {
		address = ":8080"
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid healthcheck listen address")
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/status")
	if err != nil {
		return fmt.Errorf("registry healthcheck request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("registry healthcheck status %d", response.StatusCode)
	}
	return nil
}

func run(ctx context.Context, lookup func(string) string) error {
	cfg, err := loadConfig(lookup)
	if err != nil {
		return err
	}
	poolConfig, err := pgxpool.ParseConfig(cfg.databaseURL)
	if err != nil {
		return fmt.Errorf("invalid Registry database configuration")
	}
	poolConfig.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return fmt.Errorf("open Registry database pool: %w", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("registry database is unavailable")
	}
	if err := registry.ApplyMigrations(ctx, pool); err != nil {
		return fmt.Errorf("registry schema migration failed: %w", err)
	}
	listener, err := net.Listen("tcp", cfg.listenAddress)
	if err != nil {
		return fmt.Errorf("registry listener failed: %w", err)
	}
	server := &http.Server{
		Handler:           registry.NewHandler(registry.NewService(registry.NewPostgresStore(pool)), cfg.apiToken, pool.Ping),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      45 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	shutdown := make(chan error, 1)
	go func() {
		<-serveCtx.Done()
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		shutdown <- server.Shutdown(stopCtx)
	}()
	err = server.Serve(listener)
	cancel()
	if shutdownErr := <-shutdown; shutdownErr != nil {
		return shutdownErr
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
