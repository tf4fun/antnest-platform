// Package devsecrets enforces published-development-secret admission.
package devsecrets

import (
	"bytes"
	"fmt"
	"log/slog"
	"slices"

	"github.com/jackc/pgx/v5/pgconn"
)

const OptInVariable = "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"

var publishedValues = []string{
	"antnest-postgres-dev", "antnest-egress-dev", "antnest-runtime-controller-dev",
	"antnest-agent-acp-dev", "antnest-identity-dev", "antnest-agent-controller-dev",
	"antnest-skill-registry-dev", "antnest-temporal-dev", "antnest-admin-dev",
	"antnest-skill-registry-local-development-token",
}

type Policy struct {
	allow    bool
	warnings []string
}

func New(optIn string) (*Policy, error) {
	switch optIn {
	case "", "false", "true":
		return &Policy{allow: optIn == "true"}, nil
	default:
		return nil, fmt.Errorf("%s must be exactly true or false", OptInVariable)
	}
}

func (p *Policy) CheckValue(variable, value string) error {
	return p.check(variable, slices.Contains(publishedValues, value))
}

func (p *Policy) CheckKey(variable string, key []byte) error {
	return p.check(variable, len(key) == 32 && bytes.Equal(key, bytes.Repeat(key[:1], len(key))))
}

func (p *Policy) CheckDatabaseURL(variable, raw string) error {
	// Match URL escaping, query overrides and keyword DSNs to the driver.
	config, err := pgconn.ParseConfig(raw)
	if err != nil {
		return fmt.Errorf("%s must be a valid PostgreSQL connection string", variable)
	}
	return p.CheckValue(variable, config.Password)
}

func (p *Policy) check(variable string, published bool) error {
	if !published {
		return nil
	}
	if !p.allow {
		return fmt.Errorf("%s uses a published development value", variable)
	}
	if !slices.Contains(p.warnings, variable) {
		p.warnings = append(p.warnings, variable)
	}
	return nil
}

func (p *Policy) Warnings() []string { return slices.Clone(p.warnings) }

func LogWarnings(logger *slog.Logger, variables []string) {
	for _, variable := range variables {
		logger.Warn("Published development secret explicitly enabled", "variable", variable)
	}
}
