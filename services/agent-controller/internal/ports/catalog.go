package ports

import (
	"context"
	"errors"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

var (
	ErrNotFound          = errors.New("record not found")
	ErrDisabledReference = errors.New("reference is disabled")
	ErrRequestConflict   = errors.New("request identity conflict")
	ErrConcurrentChange  = errors.New("concurrent catalog change")
)

type SealedSecret struct {
	Ciphertext []byte
	Nonce      []byte
}

type CredentialSealer interface {
	Seal(ctx context.Context, credentialRef string, plaintext string) (SealedSecret, error)
}

type ModelProfileRecord struct {
	RequestID          string
	RequestFingerprint string
	ModelProfileID     string
	OrganizationID     string
	ProfileKey         string
	DisplayName        string
	Revision           domain.ModelProfileRevision
	CredentialRef      string
	CredentialVersion  string
	SealedCredential   SealedSecret
	Enabled            bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
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
	PutModelProfile(ctx context.Context, record ModelProfileRecord) (ModelProfileRecord, error)
	ReviseModelProfile(ctx context.Context, expectedRevision int64, record ModelProfileRecord) (ModelProfileRecord, error)
	GetModelProfile(ctx context.Context, id string) (ModelProfileRecord, error)
	GetModelProfileRevision(ctx context.Context, id string) (domain.ModelProfileRevision, error)
	ListModelProfiles(ctx context.Context, organizationID string, afterID string, limit int) ([]ModelProfileRecord, string, error)
	PutTemplate(ctx context.Context, record TemplateRecord) (TemplateRecord, error)
	ReviseTemplate(ctx context.Context, expectedRevision int64, record TemplateRecord) (TemplateRecord, error)
	GetTemplate(ctx context.Context, id string) (TemplateRecord, error)
	ListTemplates(ctx context.Context, organizationID string, afterID string, limit int) ([]TemplateRecord, string, error)
}

type Clock interface {
	Now() time.Time
}
