package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/devsecrets"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/config"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func runRekey(ctx context.Context, lookup serviceauth.LookupEnv, args []string, output io.Writer) error {
	batchSize, err := secretencryption.ParseRekeyArgs(args)
	if err != nil {
		return classifyFailure("rekey_arguments", err)
	}
	cfg, err := config.LoadRekey(lookup)
	if err != nil {
		return classifyFailure("configuration", err)
	}
	devsecrets.LogWarnings(slog.Default(), cfg.DevelopmentSecretWarnings)
	box, err := credentials.NewKeyring(cfg.Encryption)
	if err != nil {
		return classifyFailure("rekey_configuration", err)
	}
	poolConfig, err := repository.ParsePoolConfig(cfg.DatabaseURL)
	if err != nil {
		return classifyFailure("rekey_database_configuration", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return classifyFailure("rekey_database_startup", err)
	}
	defer pool.Close()
	if err := repository.ApplyMigrations(ctx, pool); err != nil {
		return classifyFailure("rekey_database_migration", err)
	}
	store, err := repository.New(pool, identityid.MustNew, time.Now)
	if err != nil {
		return classifyFailure("rekey_configuration", err)
	}
	encoder := json.NewEncoder(output)
	if err := store.RekeyOIDCSecrets(ctx, box, batchSize, func(progress secretencryption.Progress) error { return encoder.Encode(progress) }); err != nil {
		return classifyFailure("rekey_rotation", err)
	}
	return nil
}
