package application

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type ProviderCredentialInput struct {
	Method string `json:"method"`
	APIKey string `json:"api_key"`
}

type ProviderModelInput struct {
	ProfileKey  string                 `json:"profile_key"`
	DisplayName string                 `json:"display_name"`
	Model       domain.ModelParameters `json:"model"`
}

type CreateProviderConnectionInput struct {
	RequestID      string
	OrganizationID string
	ProviderKey    string
	DisplayName    string
	BaseURL        string
	Credential     ProviderCredentialInput
	Models         []ProviderModelInput
}

type RotateProviderCredentialInput struct {
	RequestID       string
	OrganizationID  string
	ConnectionID    string
	ExpectedVersion string
	Credential      ProviderCredentialInput
}

type ProviderConnectionView struct {
	ConnectionID       string    `json:"connection_id"`
	OrganizationID     string    `json:"organization_id"`
	ProviderKey        string    `json:"provider_key"`
	DisplayName        string    `json:"display_name"`
	BaseURL            string    `json:"base_url"`
	CredentialMethod   string    `json:"credential_method"`
	CredentialVersion  string    `json:"credential_version"`
	CredentialRevision int64     `json:"credential_revision"`
	Enabled            bool      `json:"enabled"`
	RequestProtocol    string    `json:"request_protocol"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type ProviderConnectionPage struct {
	Items       []ProviderConnectionView `json:"items"`
	NextAfterID string                   `json:"next_after_id,omitempty"`
}

func (service *CatalogService) CreateProviderConnection(ctx context.Context, input CreateProviderConnectionInput) (ProviderConnectionView, error) {
	if err := validateProviderInput(input); err != nil {
		return ProviderConnectionView{}, err
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ProviderConnectionView{}, fmt.Errorf("%w: invalid Provider configuration encoding", ErrInvalidInput)
	}
	replayed, found, err := service.store.ReplayProviderRequest(ctx, ports.CreateProviderConnectionRequest, input.RequestID, fingerprint)
	if err != nil || found {
		return providerConnectionView(replayed), err
	}
	now := service.clock.Now()
	connection := ports.ProviderConnectionRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		ConnectionID: derivedID("provider", input.RequestID), OrganizationID: input.OrganizationID,
		ProviderKey: input.ProviderKey, DisplayName: input.DisplayName, BaseURL: input.BaseURL,
		CredentialMethod: input.Credential.Method, CredentialVersion: derivedID("credver", input.RequestID),
		CredentialRevision: 1, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}
	models, err := initialProviderModels(connection, input.Models)
	if err != nil {
		return ProviderConnectionView{}, err
	}
	connection.SealedCredential, err = service.sealProviderCredential(ctx, connection, input.Credential.APIKey)
	if err != nil {
		return ProviderConnectionView{}, err
	}
	stored, err := service.store.PutProviderConnection(ctx, connection, models)
	return providerConnectionView(stored), err
}

func (service *CatalogService) RotateProviderCredential(ctx context.Context, input RotateProviderCredentialInput) (ProviderConnectionView, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) || !validIdentifier(input.ConnectionID) ||
		!validIdentifier(input.ExpectedVersion) || !validAPIKey(input.Credential) {
		return ProviderConnectionView{}, fmt.Errorf("%w: Provider credential input", ErrInvalidInput)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ProviderConnectionView{}, err
	}
	replayed, found, err := service.store.ReplayProviderRequest(ctx, ports.RotateProviderCredentialRequest, input.RequestID, fingerprint)
	if err != nil || found {
		return providerConnectionView(replayed), err
	}
	connection, err := service.store.GetProviderConnection(ctx, input.OrganizationID, input.ConnectionID)
	if err != nil {
		return ProviderConnectionView{}, err
	}
	connection.RequestID, connection.RequestFingerprint = input.RequestID, fingerprint
	connection.CredentialVersion = derivedID("credver", input.RequestID)
	connection.CredentialRevision++
	connection.UpdatedAt = service.clock.Now()
	connection.SealedCredential, err = service.sealProviderCredential(ctx, connection, input.Credential.APIKey)
	if err != nil {
		return ProviderConnectionView{}, err
	}
	stored, err := service.store.RotateProviderCredential(ctx, input.ExpectedVersion, connection)
	return providerConnectionView(stored), err
}

func (service *CatalogService) GetProviderConnection(ctx context.Context, organizationID, connectionID string) (ProviderConnectionView, error) {
	if !validIdentifier(organizationID) || !validIdentifier(connectionID) {
		return ProviderConnectionView{}, ErrInvalidInput
	}
	connection, err := service.store.GetProviderConnection(ctx, organizationID, connectionID)
	return providerConnectionView(connection), err
}

func (service *CatalogService) ListProviderConnections(ctx context.Context, input ListCatalogInput) (ProviderConnectionPage, error) {
	input, err := validateListCatalogInput(input)
	if err != nil {
		return ProviderConnectionPage{}, err
	}
	records, after, err := service.store.ListProviderConnections(ctx, input.OrganizationID, input.AfterID, input.Limit)
	if err != nil {
		return ProviderConnectionPage{}, err
	}
	items := make([]ProviderConnectionView, 0, len(records))
	for _, record := range records {
		items = append(items, providerConnectionView(record))
	}
	return ProviderConnectionPage{Items: items, NextAfterID: after}, nil
}

func (service *CatalogService) sealProviderCredential(ctx context.Context, connection ports.ProviderConnectionRecord, secret string) (ports.SealedSecret, error) {
	sealed, err := service.sealer.Seal(ctx, ports.CredentialIdentity{
		OrganizationID: connection.OrganizationID, CredentialRef: connection.ConnectionID, CredentialVersion: connection.CredentialVersion,
	}, secret)
	if err != nil {
		return ports.SealedSecret{}, fmt.Errorf("seal Provider credential: %w", err)
	}
	return sealed, nil
}

func validateProviderInput(input CreateProviderConnectionInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) || strings.TrimSpace(input.DisplayName) == "" {
		return fmt.Errorf("%w: Provider identity", ErrInvalidInput)
	}
	support, supported := supportedProvider(input.ProviderKey)
	if !supported || support.credentialMethod != input.Credential.Method || !validAPIKey(input.Credential) {
		return fmt.Errorf("%w: unsupported Provider or credential method", ErrInvalidInput)
	}
	endpoint, err := url.Parse(input.BaseURL)
	if err != nil || endpoint == nil || (endpoint.Scheme != "https" && endpoint.Scheme != "http") ||
		endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return fmt.Errorf("%w: Provider endpoint", ErrInvalidInput)
	}
	if input.Models == nil || len(input.Models) > maximumCatalogPageSize {
		return fmt.Errorf("%w: too many initial models", ErrInvalidInput)
	}
	return nil
}

func validAPIKey(input ProviderCredentialInput) bool {
	return input.Method == "api_key" && strings.TrimSpace(input.APIKey) != ""
}

func (service *CatalogService) loadEnabledProvider(ctx context.Context, organizationID, connectionID string) (ports.ProviderConnectionRecord, error) {
	connection, err := service.store.GetProviderConnection(ctx, organizationID, connectionID)
	if err != nil {
		return ports.ProviderConnectionRecord{}, err
	}
	if !connection.Enabled {
		return ports.ProviderConnectionRecord{}, ports.ErrDisabledReference
	}
	return connection, nil
}

func initialProviderModels(connection ports.ProviderConnectionRecord, inputs []ProviderModelInput) ([]ports.ModelProfileRecord, error) {
	models := make([]ports.ModelProfileRecord, 0, len(inputs))
	keys, modelIDs := make(map[string]bool), make(map[string]bool)
	for _, input := range inputs {
		if keys[input.ProfileKey] || modelIDs[input.Model.Model] {
			return nil, fmt.Errorf("%w: duplicate initial model", ErrInvalidInput)
		}
		keys[input.ProfileKey], modelIDs[input.Model.Model] = true, true
		requestID := derivedID("initialmodel", connection.RequestID+":"+input.ProfileKey)
		record, err := newProviderModel(connection, requestID, input, 1, derivedID("model", requestID))
		if err != nil {
			return nil, err
		}
		models = append(models, record)
	}
	return models, nil
}

func newProviderModel(connection ports.ProviderConnectionRecord, requestID string, input ProviderModelInput, number int64, modelID string) (ports.ModelProfileRecord, error) {
	if !validIdentifier(input.ProfileKey) || !validModelDisplayName(input.DisplayName) {
		return ports.ModelProfileRecord{}, fmt.Errorf("%w: Model identity", ErrInvalidInput)
	}
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: derivedID("modelrev", requestID), ModelProfileID: modelID, OrganizationID: connection.OrganizationID,
		Revision: number, Model: input.Model.WithEndpoint(connection.BaseURL),
	})
	if err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	return ports.ModelProfileRecord{
		ProviderConnectionID: connection.ConnectionID, ModelProfileID: modelID, OrganizationID: connection.OrganizationID,
		ProfileKey: input.ProfileKey, DisplayName: input.DisplayName, Revision: revision,
		Enabled: true, CreatedAt: connection.CreatedAt, UpdatedAt: connection.UpdatedAt,
	}, nil
}

func providerConnectionView(record ports.ProviderConnectionRecord) ProviderConnectionView {
	support, _ := supportedProvider(record.ProviderKey)
	return ProviderConnectionView{
		RequestProtocol: support.requestProtocol,
		ConnectionID:    record.ConnectionID, OrganizationID: record.OrganizationID, ProviderKey: record.ProviderKey,
		DisplayName: record.DisplayName, BaseURL: record.BaseURL, CredentialMethod: record.CredentialMethod,
		CredentialVersion: record.CredentialVersion, CredentialRevision: record.CredentialRevision,
		Enabled: record.Enabled, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
	}
}
