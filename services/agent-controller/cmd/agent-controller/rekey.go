package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/devsecrets"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/config"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/repository/postgres"
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
	store, err := postgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return classifyFailure("rekey_database_startup", err)
	}
	defer store.Close()
	if err := store.Migrate(ctx); err != nil {
		return classifyFailure("rekey_database_migration", err)
	}
	encoder := json.NewEncoder(output)
	if err := store.RekeyProviderCredentials(ctx, box, batchSize, func(progress secretencryption.Progress) error { return encoder.Encode(progress) }); err != nil {
		return classifyFailure("rekey_rotation", err)
	}
	return nil
}
