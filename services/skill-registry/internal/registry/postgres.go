package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func databaseError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "skills_organization_id_name_key" {
		return failure("name_conflict", "Skill name already exists in organization")
	}
	return fmt.Errorf("registry storage unavailable: %w", err)
}

func (s *PostgresStore) Receipt(ctx context.Context, org, requestID string) (string, Version, bool, error) {
	var fingerprint string
	var encoded []byte
	err := s.pool.QueryRow(ctx, `SELECT fingerprint, result FROM command_receipts
        WHERE organization_id = $1 AND request_id = $2`, org, requestID).Scan(&fingerprint, &encoded)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", Version{}, false, nil
	}
	if err != nil {
		return "", Version{}, false, databaseError(err)
	}
	var value Version
	if len(encoded) == 0 || json.Unmarshal(encoded, &value) != nil || value.SkillID == "" {
		return "", Version{}, false, failure("temporarily_unavailable", "publication receipt is incomplete")
	}
	return fingerprint, value, true, nil
}

func (s *PostgresStore) Publish(ctx context.Context, input PublishRecord) (Version, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Version{}, databaseError(err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	command, err := tx.Exec(ctx, `INSERT INTO command_receipts (organization_id, request_id, fingerprint, result)
        VALUES ($1, $2, $3, '{}'::jsonb) ON CONFLICT DO NOTHING`,
		input.OrganizationID, input.RequestID, input.Fingerprint)
	if err != nil {
		return Version{}, databaseError(err)
	}
	if command.RowsAffected() == 0 {
		var fingerprint string
		var frozen []byte
		err := tx.QueryRow(ctx, `SELECT fingerprint, result FROM command_receipts
            WHERE organization_id = $1 AND request_id = $2 FOR UPDATE`,
			input.OrganizationID, input.RequestID).Scan(&fingerprint, &frozen)
		if err != nil {
			return Version{}, databaseError(err)
		}
		if fingerprint != input.Fingerprint {
			return Version{}, failure("request_conflict", "request ID was used with different input")
		}
		var previous Version
		if len(frozen) == 0 || json.Unmarshal(frozen, &previous) != nil || previous.SkillID == "" {
			return Version{}, failure("temporarily_unavailable", "publication receipt is incomplete")
		}
		return previous, nil
	}
	version := int64(1)
	id := input.NewSkillID
	if input.SkillID == "" {
		_, err = tx.Exec(ctx, `INSERT INTO skills (skill_id, organization_id, name, current_version, created_by)
            VALUES ($1, $2, $3, 1, $4)`, id, input.OrganizationID, input.Package.Name, input.ActorID)
		if err != nil {
			return Version{}, databaseError(err)
		}
	} else {
		var head int64
		var name string
		err = tx.QueryRow(ctx, `SELECT current_version, name FROM skills
            WHERE skill_id = $1 AND organization_id = $2 FOR UPDATE`,
			input.SkillID, input.OrganizationID).Scan(&head, &name)
		if errors.Is(err, pgx.ErrNoRows) {
			return Version{}, failure("not_found", "Skill not found")
		}
		if err != nil {
			return Version{}, databaseError(err)
		}
		if name != input.Package.Name {
			return Version{}, failure("invalid_package", "Skill name cannot change between versions")
		}
		if head != input.ExpectedVersion {
			return Version{}, failure("revision_conflict", "current Skill version changed")
		}
		version = head + 1
		_, err = tx.Exec(ctx, `UPDATE skills SET current_version = $1 WHERE skill_id = $2`, version, input.SkillID)
		if err != nil {
			return Version{}, databaseError(err)
		}
	}
	value := Version{SkillID: id, Version: version, Name: input.Package.Name,
		Description: input.Package.Description, ArtifactDigest: input.Package.ArtifactDigest,
		ContentDigest: input.Package.ContentDigest, ArtifactSize: len(input.Package.Artifact),
		UnpackedSize: input.Package.UnpackedSize, PackageRulesVersion: PackageRulesVersion}
	metadata, err := json.Marshal(value)
	if err != nil {
		return Version{}, err
	}
	manifest, err := json.Marshal(input.Package.Files)
	if err != nil {
		return Version{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO skill_versions
        (skill_id, version, metadata, file_manifest, artifact, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)`,
		id, version, metadata, manifest, input.Package.Artifact, input.ActorID)
	if err != nil {
		return Version{}, databaseError(err)
	}
	if input.Provenance != nil {
		provenance, err := json.Marshal(input.Provenance)
		if err != nil {
			return Version{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO skill_version_sources (skill_id, version, provenance)
			VALUES ($1, $2, $3)`, id, version, provenance); err != nil {
			return Version{}, databaseError(err)
		}
	}
	_, err = tx.Exec(ctx, `UPDATE command_receipts SET result = $1
        WHERE organization_id = $2 AND request_id = $3`, metadata, input.OrganizationID, input.RequestID)
	if err != nil {
		return Version{}, databaseError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Version{}, databaseError(err)
	}
	return value, nil
}

func (s *PostgresStore) GetVersion(ctx context.Context, org, id string, version int64) (Version, error) {
	var encoded []byte
	err := s.pool.QueryRow(ctx, `SELECT v.metadata FROM skill_versions v
        JOIN skills s ON s.skill_id = v.skill_id
        WHERE s.organization_id = $1 AND s.skill_id = $2 AND v.version = $3`,
		org, id, version).Scan(&encoded)
	if errors.Is(err, pgx.ErrNoRows) {
		return Version{}, failure("not_found", "Skill version not found")
	}
	if err != nil {
		return Version{}, databaseError(err)
	}
	var value Version
	if err := json.Unmarshal(encoded, &value); err != nil {
		return Version{}, fmt.Errorf("decode stored Skill version: %w", err)
	}
	return value, nil
}

func (s *PostgresStore) List(ctx context.Context, org, after string, limit int) ([]Skill, error) {
	rows, err := s.pool.Query(ctx, `SELECT s.skill_id, s.name, s.current_version, v.metadata
        FROM skills s JOIN skill_versions v
        ON v.skill_id = s.skill_id AND v.version = s.current_version
        WHERE s.organization_id = $1 AND s.skill_id > $2 ORDER BY s.skill_id LIMIT $3`, org, after, limit)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	items := make([]Skill, 0, limit)
	for rows.Next() {
		var item Skill
		var encoded []byte
		if err := rows.Scan(&item.SkillID, &item.Name, &item.CurrentVersion, &encoded); err != nil {
			return nil, databaseError(err)
		}
		var current Version
		if err := json.Unmarshal(encoded, &current); err != nil || current.SkillID != item.SkillID || current.Version != item.CurrentVersion {
			return nil, failure("temporarily_unavailable", "stored Skill head metadata is inconsistent")
		}
		item.Description, item.ArtifactDigest, item.ContentDigest = current.Description, current.ArtifactDigest, current.ContentDigest
		item.ArtifactSize, item.UnpackedSize, item.PackageRulesVersion = current.ArtifactSize, current.UnpackedSize, current.PackageRulesVersion
		items = append(items, item)
	}
	return items, databaseError(rows.Err())
}

func (s *PostgresStore) Versions(ctx context.Context, org, id string, after int64, limit int) ([]Version, error) {
	var exists int
	err := s.pool.QueryRow(ctx, `SELECT 1 FROM skills WHERE organization_id = $1 AND skill_id = $2`, org, id).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, failure("not_found", "Skill not found")
	}
	if err != nil {
		return nil, databaseError(err)
	}
	rows, err := s.pool.Query(ctx, `SELECT v.metadata FROM skill_versions v
        JOIN skills s ON s.skill_id = v.skill_id
        WHERE s.organization_id = $1 AND s.skill_id = $2 AND v.version > $3
        ORDER BY v.version LIMIT $4`, org, id, after, limit)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	items := make([]Version, 0, limit)
	for rows.Next() {
		var encoded []byte
		var item Version
		if err := rows.Scan(&encoded); err != nil {
			return nil, databaseError(err)
		}
		if err := json.Unmarshal(encoded, &item); err != nil {
			return nil, fmt.Errorf("decode stored Skill version: %w", err)
		}
		items = append(items, item)
	}
	return items, databaseError(rows.Err())
}

func (s *PostgresStore) Artifact(ctx context.Context, org, id string, version int64) (Version, []byte, error) {
	var metadata, artifact []byte
	err := s.pool.QueryRow(ctx, `SELECT v.metadata, v.artifact FROM skill_versions v
        JOIN skills s ON s.skill_id = v.skill_id
        WHERE s.organization_id = $1 AND s.skill_id = $2 AND v.version = $3`,
		org, id, version).Scan(&metadata, &artifact)
	if errors.Is(err, pgx.ErrNoRows) {
		return Version{}, nil, failure("not_found", "Skill version not found")
	}
	if err != nil {
		return Version{}, nil, databaseError(err)
	}
	var value Version
	if err := json.Unmarshal(metadata, &value); err != nil || digest(artifact) != value.ArtifactDigest || len(artifact) != value.ArtifactSize {
		return Version{}, nil, failure("temporarily_unavailable", "stored artifact does not match its identity")
	}
	return value, artifact, nil
}
