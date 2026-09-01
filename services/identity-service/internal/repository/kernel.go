package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

type Store struct {
	pool  *pgxpool.Pool
	newID func() string
}

var (
	repositoryTracer     = otel.Tracer("soft/antnest-platform/identity-service/repository")
	repositoryMeter      = otel.Meter("soft/antnest-platform/identity-service/repository")
	repositoryOperations = mustCounter(repositoryMeter.Int64Counter("antnest.identity.repository.operations"))
	repositoryDuration   = mustHistogram(repositoryMeter.Float64Histogram(
		"antnest.identity.repository.duration", metric.WithUnit("s"),
	))
)

func New(pool *pgxpool.Pool, newID func() string) (*Store, error) {
	if pool == nil || newID == nil {
		return nil, fmt.Errorf("identity repository requires pool and ID generator")
	}
	return &Store{pool: pool, newID: newID}, nil
}

func (s *Store) Directory() *DirectoryAdapter { return &DirectoryAdapter{store: s} }
func (s *Store) LocalAuth() *LocalAuthAdapter { return &LocalAuthAdapter{store: s} }
func (s *Store) OIDC() *OIDCAdapter           { return &OIDCAdapter{store: s} }
func (s *Store) SCIM() *SCIMAdapter           { return &SCIMAdapter{store: s} }

func (s *Store) Ping(ctx context.Context) error {
	return observeRepositoryError(ctx, "ping", func(ctx context.Context) error {
		if err := s.pool.Ping(ctx); err != nil {
			return fmt.Errorf("ping identity database: %w", err)
		}
		return nil
	})
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) inTransaction(
	ctx context.Context,
	operationName string,
	operation func(pgx.Tx) error,
) (resultErr error) {
	ctx, finish := startRepositoryOperation(ctx, operationName)
	defer func() { finish(resultErr) }()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin identity transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := operation(tx); err != nil {
		return normalizeError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return normalizeError(fmt.Errorf("commit identity transaction: %w", err))
	}
	return nil
}

func observeRepositoryValue[T any](
	ctx context.Context,
	operationName string,
	operation func(context.Context) (T, error),
) (result T, resultErr error) {
	ctx, finish := startRepositoryOperation(ctx, operationName)
	defer func() { finish(resultErr) }()
	return operation(ctx)
}

func observeRepositoryError(
	ctx context.Context,
	operationName string,
	operation func(context.Context) error,
) (resultErr error) {
	ctx, finish := startRepositoryOperation(ctx, operationName)
	defer func() { finish(resultErr) }()
	return operation(ctx)
}

func startRepositoryOperation(ctx context.Context, operationName string) (context.Context, func(error)) {
	ctx, span := repositoryTracer.Start(
		ctx, "identity.repository."+operationName, trace.WithSpanKind(trace.SpanKindClient),
	)
	started := time.Now()
	return ctx, func(err error) {
		finishRepositoryOperation(ctx, span, started, operationName, err)
	}
}

func finishRepositoryOperation(
	ctx context.Context,
	span trace.Span,
	started time.Time,
	operation string,
	err error,
) {
	result := "success"
	errorClass := "none"
	if err != nil {
		result = "error"
		errorClass = repositoryErrorClass(err)
		span.RecordError(errors.New(errorClass))
		span.SetStatus(codes.Error, errorClass)
	}
	attributes := []attribute.KeyValue{
		attribute.String("db.system.name", "postgresql"),
		attribute.String("antnest.repository.operation", operation),
		attribute.String("antnest.result", result),
		attribute.String("error.type", errorClass),
	}
	span.SetAttributes(attributes...)
	span.End()
	repositoryOperations.Add(ctx, 1, metric.WithAttributes(attributes...))
	repositoryDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
}

func repositoryErrorClass(err error) string {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return "not_found"
	case errors.Is(err, domain.ErrConflict):
		return "conflict"
	case errors.Is(err, domain.ErrForbidden):
		return "forbidden"
	}
	var domainError *domain.Error
	if errors.As(err, &domainError) {
		switch domainError.Code {
		case domain.ErrInvalidArgument.Code:
			return "invalid_argument"
		case domain.ErrInvalidReference.Code:
			return "invalid_reference"
		case domain.ErrVersionConflict.Code:
			return "version_conflict"
		case domain.ErrUnauthenticated.Code:
			return "unauthenticated"
		case domain.ErrInactive.Code:
			return "inactive_principal"
		default:
			return "domain_error"
		}
	}
	return "persistence_error"
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}

func mustHistogram(instrument metric.Float64Histogram, err error) metric.Float64Histogram {
	if err != nil {
		panic(err)
	}
	return instrument
}

type event struct {
	OrganizationID   string
	ActorPrincipalID string
	ActorSCIMTokenID string
	Type             string
	SubjectType      string
	SubjectID        string
	RequestID        string
	Metadata         map[string]any
	CreatedAt        time.Time
}

func (s *Store) appendEvent(ctx context.Context, tx pgx.Tx, value event) error {
	metadata, err := json.Marshal(value.Metadata)
	if err != nil {
		return fmt.Errorf("encode identity event metadata: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO identity_events (
			id, organization_id, actor_principal_id, actor_scim_token_id,
			event_type, subject_type, subject_id, request_id, metadata, created_at
		) VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, NULLIF($8, ''), $9, $10)`,
		s.newID(), value.OrganizationID, value.ActorPrincipalID, value.ActorSCIMTokenID,
		value.Type, value.SubjectType, value.SubjectID, value.RequestID, metadata, value.CreatedAt,
	); err != nil {
		return fmt.Errorf("append identity event: %w", err)
	}
	return nil
}

func (s *Store) getPrincipal(
	ctx context.Context,
	queryer interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	userID string,
	organizationID string,
) (domain.Principal, error) {
	if organizationID == "" {
		var principal domain.Principal
		err := queryer.QueryRow(ctx, `
			SELECT id, system_role, active
			FROM users
			WHERE id = $1`, userID,
		).Scan(&principal.UserID, &principal.SystemRole, &principal.Active)
		if err != nil {
			return domain.Principal{}, normalizeError(err)
		}
		return principal, nil
	}
	var principal domain.Principal
	var userActive, membershipActive, organizationActive bool
	err := queryer.QueryRow(ctx, `
		SELECT u.id, o.id, COALESCE(m.id, ''), u.system_role, COALESCE(m.role, 'member'),
		       u.active, COALESCE(m.active, FALSE), o.active
		FROM users u
		JOIN organizations o ON o.id = $2
		LEFT JOIN organization_memberships m
		  ON m.user_id = u.id AND m.organization_id = o.id AND m.scim_deleted_at IS NULL
		WHERE u.id = $1`, userID, organizationID,
	).Scan(
		&principal.UserID, &principal.OrganizationID, &principal.MembershipID,
		&principal.SystemRole, &principal.OrganizationRole,
		&userActive, &membershipActive, &organizationActive,
	)
	if err != nil {
		return domain.Principal{}, normalizeError(err)
	}
	if principal.MembershipID == "" && principal.SystemRole != domain.SystemRoleAdmin {
		return domain.Principal{}, domain.ErrNotFound
	}
	principal.Active = userActive && organizationActive &&
		(principal.SystemRole == domain.SystemRoleAdmin || membershipActive)
	return principal, nil
}

func (s *Store) resolveOrganizationPrincipal(
	ctx context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	var principal domain.Principal
	var userActive, membershipActive, organizationActive bool
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, o.id, m.id, u.system_role, m.role,
		       u.active, m.active, o.active
		FROM users u
		JOIN organization_memberships m
		  ON m.user_id = u.id AND m.organization_id = $2 AND m.scim_deleted_at IS NULL
		JOIN organizations o ON o.id = m.organization_id
		WHERE u.id = $1`, userID, organizationID,
	).Scan(
		&principal.UserID, &principal.OrganizationID, &principal.MembershipID,
		&principal.SystemRole, &principal.OrganizationRole,
		&userActive, &membershipActive, &organizationActive,
	)
	if err != nil {
		return domain.Principal{}, normalizeError(err)
	}
	principal.Active = userActive && membershipActive && organizationActive
	return principal, nil
}

func (s *Store) requireSystemAdmin(ctx context.Context, tx pgx.Tx, actorUserID string) error {
	var role domain.SystemRole
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT system_role, active
		FROM users
		WHERE id = $1
		FOR SHARE`, actorUserID,
	).Scan(&role, &active); err != nil {
		return normalizeError(err)
	}
	if !active || role != domain.SystemRoleAdmin {
		return domain.ErrForbidden
	}
	return nil
}

func (s *Store) requireOrganizationAdmin(
	ctx context.Context,
	tx pgx.Tx,
	actorUserID string,
	organizationID string,
) error {
	var role domain.SystemRole
	var userActive bool
	if err := tx.QueryRow(ctx, `
		SELECT system_role, active
		FROM users
		WHERE id = $1
		FOR SHARE`, actorUserID,
	).Scan(&role, &userActive); err != nil {
		return normalizeError(err)
	}
	var organizationActive bool
	if err := tx.QueryRow(ctx, `
		SELECT active
		FROM organizations
		WHERE id = $1
		FOR SHARE`, organizationID,
	).Scan(&organizationActive); err != nil {
		return normalizeError(err)
	}
	if !userActive || !organizationActive {
		return domain.ErrForbidden
	}
	if role == domain.SystemRoleAdmin {
		return nil
	}
	var membershipRole domain.OrganizationRole
	var membershipActive bool
	if err := tx.QueryRow(ctx, `
		SELECT role, active
		FROM organization_memberships
		WHERE organization_id = $1 AND user_id = $2 AND scim_deleted_at IS NULL
		FOR SHARE`, organizationID, actorUserID,
	).Scan(&membershipRole, &membershipActive); err != nil {
		return normalizeError(err)
	}
	if !membershipActive || membershipRole != domain.OrganizationRoleAdmin {
		return domain.ErrForbidden
	}
	return nil
}

func normalizeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23505", "23503", "23514":
			return domain.ErrConflict
		}
	}
	return err
}
