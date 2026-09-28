package ports

import (
	"context"
	"errors"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

var (
	ErrNotFound                 = errors.New("record not found")
	ErrDisabledReference        = errors.New("reference is disabled")
	ErrRequestConflict          = errors.New("request identity conflict")
	ErrConcurrentChange         = errors.New("concurrent catalog change")
	ErrLegacyMigrationProofLost = errors.New("legacy migration proof lost after lifecycle admission")
	ErrInvalidModelCandidates   = errors.New("invalid template model candidates")
)

type SealedSecret struct {
	Ciphertext []byte
	Nonce      []byte
	KeyVersion string
}

type CredentialIdentity struct {
	OrganizationID    string
	CredentialRef     string
	CredentialVersion string
}

type CatalogRequestKind string

const (
	CreateModelProfileRequest CatalogRequestKind = "create_model_profile"
	ReviseModelProfileRequest CatalogRequestKind = "revise_model_profile"
	CreateTemplateRequest     CatalogRequestKind = "create_template"
	ReviseTemplateRequest     CatalogRequestKind = "revise_template"
)

type CredentialSealer interface {
	Seal(ctx context.Context, identity CredentialIdentity, plaintext string) (SealedSecret, error)
}

type CredentialOpener interface {
	Open(context.Context, CredentialIdentity, SealedSecret) (string, error)
}

type ModelProfileRecord struct {
	ProviderConnectionID string
	RequestID            string
	RequestFingerprint   string
	ModelProfileID       string
	OrganizationID       string
	ProfileKey           string
	DisplayName          string
	Revision             domain.ModelProfileRevision
	Enabled              bool
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type TemplateRecord struct {
	RequestID          string
	RequestFingerprint string
	TemplateID         string
	OrganizationID     string
	TemplateKey        string
	Name               string
	Revision           domain.TemplateRevision
	Enabled            bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type CatalogStore interface {
	CatalogAvailabilityStore
	GetCurrentModelProfileRevision(context.Context, string) (domain.ModelProfileRevision, error)
	ProviderStore
	ReplayModelProfileRequest(ctx context.Context, kind CatalogRequestKind, requestID string, fingerprint string) (ModelProfileRecord, bool, error)
	PutModelProfile(ctx context.Context, record ModelProfileRecord) (ModelProfileRecord, error)
	ReviseModelProfile(ctx context.Context, expectedRevision int64, record ModelProfileRecord) (ModelProfileRecord, error)
	GetModelProfile(ctx context.Context, id string) (ModelProfileRecord, error)
	ListModelProfiles(ctx context.Context, organizationID string, afterID string, limit int) ([]ModelProfileRecord, string, error)
	ReplayTemplateRequest(ctx context.Context, kind CatalogRequestKind, requestID string, fingerprint string) (TemplateRecord, bool, error)
	PutTemplate(ctx context.Context, record TemplateRecord) (TemplateRecord, error)
	ReviseTemplate(ctx context.Context, expectedRevision int64, record TemplateRecord) (TemplateRecord, error)
	GetTemplate(ctx context.Context, id string) (TemplateRecord, error)
	GetTemplateRevision(ctx context.Context, id string, revision int64) (domain.TemplateRevision, error)
	ListTemplates(ctx context.Context, organizationID string, afterID string, limit int) ([]TemplateRecord, string, error)
}

type Clock interface {
	Now() time.Time
}
