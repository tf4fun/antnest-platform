package ports

import (
	"context"
	"time"
)

const (
	CreateProviderConnectionRequest CatalogRequestKind = "create_provider_connection"
	RotateProviderCredentialRequest CatalogRequestKind = "rotate_provider_credential"
)

type ProviderConnectionRecord struct {
	RequestID          string
	RequestFingerprint string
	ConnectionID       string
	OrganizationID     string
	ProviderKey        string
	DisplayName        string
	BaseURL            string
	CredentialMethod   string
	CredentialVersion  string
	CredentialRevision int64
	SealedCredential   SealedSecret
	Enabled            bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type ProviderStore interface {
	ReplayProviderRequest(context.Context, CatalogRequestKind, string, string) (ProviderConnectionRecord, bool, error)
	PutProviderConnection(context.Context, ProviderConnectionRecord, []ModelProfileRecord) (ProviderConnectionRecord, error)
	RotateProviderCredential(context.Context, string, ProviderConnectionRecord) (ProviderConnectionRecord, error)
	GetProviderConnection(context.Context, string, string) (ProviderConnectionRecord, error)
	ListProviderConnections(context.Context, string, string, int) ([]ProviderConnectionRecord, string, error)
}
