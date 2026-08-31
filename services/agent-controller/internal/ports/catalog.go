package ports

import (
	"context"
	"errors"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

var (
	ErrNotFound        = errors.New("record not found")
	ErrRequestConflict = errors.New("request identity conflict")
)

type SealedSecret struct {
	Ciphertext []byte
	Nonce      []byte
}

type CredentialSealer interface {
	Seal(ctx context.Context, plaintext string) (SealedSecret, error)
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
	CreatedAt          time.Time
}

type TemplateRecord struct {
	RequestID          string
	RequestFingerprint string
	TemplateID         string
	OrganizationID     string
	TemplateKey        string
	Name               string
	Revision           domain.TemplateRevision
	CreatedAt          time.Time
}

type CatalogStore interface {
	PutModelProfile(ctx context.Context, record ModelProfileRecord) (ModelProfileRecord, error)
	GetModelProfileRevision(ctx context.Context, id string) (domain.ModelProfileRevision, error)
	PutTemplate(ctx context.Context, record TemplateRecord) (TemplateRecord, error)
}

type Clock interface {
	Now() time.Time
}
