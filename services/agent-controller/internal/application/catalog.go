package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var (
	ErrInvalidInput     = errors.New("invalid input")
	ErrInvalidReference = errors.New("invalid reference")
)

const (
	defaultCatalogPageSize = 100
	maximumCatalogPageSize = 500
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

type CatalogService struct {
	store  ports.CatalogStore
	sealer ports.CredentialSealer
	clock  ports.Clock
}

func NewCatalogService(store ports.CatalogStore, sealer ports.CredentialSealer, clock ports.Clock) *CatalogService {
	return &CatalogService{store: store, sealer: sealer, clock: clock}
}

type CreateModelProfileInput struct {
	RequestID        string
	OrganizationID   string
	ProfileKey       string
	DisplayName      string
	Model            domain.ModelSpec
	CredentialSecret string
}

type ModelProfileView struct {
	ModelProfileID    string
	OrganizationID    string
	ProfileKey        string
	DisplayName       string
	RevisionID        string
	Revision          int64
	CredentialRef     string
	CredentialVersion string
	Enabled           bool
	Model             domain.ModelSpec
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

func (service *CatalogService) CreateModelProfile(ctx context.Context, input CreateModelProfileInput) (ModelProfileView, error) {
	if err := validateModelProfileInput(input); err != nil {
		return ModelProfileView{}, err
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ModelProfileView{}, err
	}
	profileID := derivedID("model", input.RequestID)
	revisionID := derivedID("modelrev", input.RequestID)
	credentialRef := derivedID("credential", input.RequestID)
	credentialVersion := derivedID("credver", input.RequestID)
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: revisionID, ModelProfileID: profileID, OrganizationID: input.OrganizationID,
		Revision: 1, Model: input.Model, CredentialRef: credentialRef,
		CredentialVersion: credentialVersion,
	})
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	sealed, err := service.sealer.Seal(ctx, credentialRef, input.CredentialSecret)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("seal Provider credential: %w", err)
	}
	now := service.clock.Now()
	record, err := service.store.PutModelProfile(ctx, ports.ModelProfileRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		ModelProfileID: profileID, OrganizationID: input.OrganizationID,
		ProfileKey: input.ProfileKey, DisplayName: input.DisplayName,
		Revision: revision, CredentialRef: credentialRef,
		CredentialVersion: credentialVersion, SealedCredential: sealed,
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("persist ModelProfile: %w", err)
	}
	return modelProfileView(record), nil
}

type ReviseModelProfileInput struct {
	RequestID        string
	ModelProfileID   string
	DisplayName      string
	Model            domain.ModelSpec
	CredentialSecret string
}

func (service *CatalogService) ReviseModelProfile(
	ctx context.Context, input ReviseModelProfileInput,
) (ModelProfileView, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.ModelProfileID) ||
		strings.TrimSpace(input.DisplayName) == "" || strings.TrimSpace(input.CredentialSecret) == "" {
		return ModelProfileView{}, fmt.Errorf("%w: ModelProfile revision input", ErrInvalidInput)
	}
	current, err := service.store.GetModelProfile(ctx, input.ModelProfileID)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("load ModelProfile: %w", err)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ModelProfileView{}, err
	}
	revisionID := derivedID("modelrev", input.RequestID)
	credentialRef := derivedID("credential", input.RequestID)
	credentialVersion := derivedID("credver", input.RequestID)
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: revisionID, ModelProfileID: current.ModelProfileID, OrganizationID: current.OrganizationID,
		Revision: current.Revision.Revision() + 1, Model: input.Model,
		CredentialRef: credentialRef, CredentialVersion: credentialVersion,
	})
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	sealed, err := service.sealer.Seal(ctx, credentialRef, input.CredentialSecret)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("seal Provider credential: %w", err)
	}
	record, err := service.store.ReviseModelProfile(ctx, current.Revision.Revision(), ports.ModelProfileRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		ModelProfileID: current.ModelProfileID, OrganizationID: current.OrganizationID,
		ProfileKey: current.ProfileKey, DisplayName: input.DisplayName,
		Revision: revision, CredentialRef: credentialRef, CredentialVersion: credentialVersion,
		SealedCredential: sealed, Enabled: current.Enabled,
		CreatedAt: current.CreatedAt, UpdatedAt: service.clock.Now(),
	})
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("persist ModelProfile revision: %w", err)
	}
	return modelProfileView(record), nil
}

type CreateTemplateInput struct {
	RequestID              string
	OrganizationID         string
	TemplateKey            string
	Name                   string
	ModelProfileRevisionID string
	SystemPrompt           string
	MaxModelRequests       int
	ContextPolicyVersion   string
	Runtime                domain.RuntimeSpecInput
}

type TemplateView struct {
	TemplateID             string
	OrganizationID         string
	TemplateKey            string
	Name                   string
	Revision               int64
	ModelProfileRevisionID string
	SystemPrompt           string
	MaxModelRequests       int
	ContextPolicyVersion   string
	Runtime                domain.RuntimeSpecInput
	Enabled                bool
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

func (service *CatalogService) CreateTemplate(ctx context.Context, input CreateTemplateInput) (TemplateView, error) {
	if err := validateTemplateInput(input); err != nil {
		return TemplateView{}, err
	}
	modelRevision, err := service.store.GetModelProfileRevision(ctx, input.ModelProfileRevisionID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return TemplateView{}, fmt.Errorf("%w: ModelProfile revision", ErrInvalidReference)
		}
		return TemplateView{}, fmt.Errorf("load ModelProfile revision: %w", err)
	}
	if modelRevision.OrganizationID() != input.OrganizationID {
		return TemplateView{}, fmt.Errorf("%w: cross-organization ModelProfile", ErrInvalidReference)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return TemplateView{}, err
	}
	templateID := derivedID("template", input.RequestID)
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: templateID, OrganizationID: input.OrganizationID, Revision: 1,
		ModelProfileRevisionID: input.ModelProfileRevisionID,
		SystemPrompt:           input.SystemPrompt, MaxModelRequests: input.MaxModelRequests,
		Runtime: input.Runtime, ContextPolicyVersion: input.ContextPolicyVersion,
	})
	if err != nil {
		return TemplateView{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	now := service.clock.Now()
	record, err := service.store.PutTemplate(ctx, ports.TemplateRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		TemplateID: templateID, OrganizationID: input.OrganizationID,
		TemplateKey: input.TemplateKey, Name: input.Name, Revision: revision,
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		return TemplateView{}, fmt.Errorf("persist Template: %w", err)
	}
	return templateView(record), nil
}

type ReviseTemplateInput struct {
	RequestID              string
	TemplateID             string
	Name                   string
	ModelProfileRevisionID string
	SystemPrompt           string
	MaxModelRequests       int
	ContextPolicyVersion   string
	Runtime                domain.RuntimeSpecInput
}

func (service *CatalogService) ReviseTemplate(
	ctx context.Context, input ReviseTemplateInput,
) (TemplateView, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.TemplateID) ||
		!validIdentifier(input.ModelProfileRevisionID) || strings.TrimSpace(input.Name) == "" {
		return TemplateView{}, fmt.Errorf("%w: Template revision input", ErrInvalidInput)
	}
	current, err := service.store.GetTemplate(ctx, input.TemplateID)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load Template: %w", err)
	}
	modelRevision, err := service.store.GetModelProfileRevision(ctx, input.ModelProfileRevisionID)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load ModelProfile revision: %w", err)
	}
	if modelRevision.OrganizationID() != current.OrganizationID {
		return TemplateView{}, fmt.Errorf("%w: cross-organization ModelProfile", ErrInvalidReference)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return TemplateView{}, err
	}
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: current.TemplateID, OrganizationID: current.OrganizationID,
		Revision: current.Revision.Revision() + 1, ModelProfileRevisionID: input.ModelProfileRevisionID,
		SystemPrompt: input.SystemPrompt, MaxModelRequests: input.MaxModelRequests,
		ContextPolicyVersion: input.ContextPolicyVersion, Runtime: input.Runtime,
	})
	if err != nil {
		return TemplateView{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	record, err := service.store.ReviseTemplate(ctx, current.Revision.Revision(), ports.TemplateRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		TemplateID: current.TemplateID, OrganizationID: current.OrganizationID,
		TemplateKey: current.TemplateKey, Name: input.Name, Revision: revision,
		Enabled: current.Enabled, CreatedAt: current.CreatedAt, UpdatedAt: service.clock.Now(),
	})
	if err != nil {
		return TemplateView{}, fmt.Errorf("persist Template revision: %w", err)
	}
	return templateView(record), nil
}

type ListCatalogInput struct {
	OrganizationID string
	AfterID        string
	Limit          int
}

type ModelProfilePage struct {
	Items       []ModelProfileView
	NextAfterID string
}

type TemplatePage struct {
	Items       []TemplateView
	NextAfterID string
}

func (service *CatalogService) GetModelProfile(ctx context.Context, id string) (ModelProfileView, error) {
	if !validIdentifier(id) {
		return ModelProfileView{}, fmt.Errorf("%w: ModelProfile identity", ErrInvalidInput)
	}
	record, err := service.store.GetModelProfile(ctx, id)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("load ModelProfile: %w", err)
	}
	return modelProfileView(record), nil
}

func (service *CatalogService) ListModelProfiles(
	ctx context.Context, input ListCatalogInput,
) (ModelProfilePage, error) {
	input, err := validateListCatalogInput(input)
	if err != nil {
		return ModelProfilePage{}, err
	}
	records, next, err := service.store.ListModelProfiles(ctx, input.OrganizationID, input.AfterID, input.Limit)
	if err != nil {
		return ModelProfilePage{}, fmt.Errorf("list ModelProfiles: %w", err)
	}
	views := make([]ModelProfileView, 0, len(records))
	for _, record := range records {
		views = append(views, modelProfileView(record))
	}
	return ModelProfilePage{Items: views, NextAfterID: next}, nil
}

func (service *CatalogService) GetTemplate(ctx context.Context, id string) (TemplateView, error) {
	if !validIdentifier(id) {
		return TemplateView{}, fmt.Errorf("%w: Template identity", ErrInvalidInput)
	}
	record, err := service.store.GetTemplate(ctx, id)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load Template: %w", err)
	}
	return templateView(record), nil
}

func (service *CatalogService) ListTemplates(
	ctx context.Context, input ListCatalogInput,
) (TemplatePage, error) {
	input, err := validateListCatalogInput(input)
	if err != nil {
		return TemplatePage{}, err
	}
	records, next, err := service.store.ListTemplates(ctx, input.OrganizationID, input.AfterID, input.Limit)
	if err != nil {
		return TemplatePage{}, fmt.Errorf("list Templates: %w", err)
	}
	views := make([]TemplateView, 0, len(records))
	for _, record := range records {
		views = append(views, templateView(record))
	}
	return TemplatePage{Items: views, NextAfterID: next}, nil
}

func validateModelProfileInput(input CreateModelProfileInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) || !validIdentifier(input.ProfileKey) {
		return fmt.Errorf("%w: request, organization, or profile identity", ErrInvalidInput)
	}
	if strings.TrimSpace(input.DisplayName) == "" || strings.TrimSpace(input.CredentialSecret) == "" {
		return fmt.Errorf("%w: display name and credential are required", ErrInvalidInput)
	}
	return nil
}

func validateTemplateInput(input CreateTemplateInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) ||
		!validIdentifier(input.TemplateKey) || !validIdentifier(input.ModelProfileRevisionID) {
		return fmt.Errorf("%w: Template identity or reference", ErrInvalidInput)
	}
	if strings.TrimSpace(input.Name) == "" {
		return fmt.Errorf("%w: Template name is required", ErrInvalidInput)
	}
	return nil
}

func validateListCatalogInput(input ListCatalogInput) (ListCatalogInput, error) {
	if !validIdentifier(input.OrganizationID) || (input.AfterID != "" && !validIdentifier(input.AfterID)) {
		return ListCatalogInput{}, fmt.Errorf("%w: Catalog list identity", ErrInvalidInput)
	}
	if input.Limit == 0 {
		input.Limit = defaultCatalogPageSize
	}
	if input.Limit < 1 || input.Limit > maximumCatalogPageSize {
		return ListCatalogInput{}, fmt.Errorf("%w: Catalog page limit", ErrInvalidInput)
	}
	return input, nil
}

func requestFingerprint(value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("fingerprint request: %w", err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}

func derivedID(prefix string, requestID string) string {
	digest := sha256.Sum256([]byte(prefix + "\x00" + requestID))
	return prefix + "_" + hex.EncodeToString(digest[:16])
}

func validIdentifier(value string) bool { return identifierPattern.MatchString(value) }

func modelProfileView(record ports.ModelProfileRecord) ModelProfileView {
	snapshot := record.Revision.Snapshot()
	return ModelProfileView{
		ModelProfileID: record.ModelProfileID, OrganizationID: record.OrganizationID,
		ProfileKey: record.ProfileKey, DisplayName: record.DisplayName,
		RevisionID: record.Revision.ID(), Revision: record.Revision.Revision(),
		CredentialRef: record.CredentialRef, CredentialVersion: record.CredentialVersion,
		Enabled: record.Enabled, Model: snapshot.Model,
		CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
	}
}

func templateView(record ports.TemplateRecord) TemplateView {
	snapshot := record.Revision.Snapshot()
	return TemplateView{
		TemplateID: record.TemplateID, OrganizationID: record.OrganizationID,
		TemplateKey: record.TemplateKey, Name: record.Name,
		Revision:               record.Revision.Revision(),
		ModelProfileRevisionID: record.Revision.ModelProfileRevisionID(),
		SystemPrompt:           snapshot.SystemPrompt,
		MaxModelRequests:       snapshot.MaxModelRequests,
		ContextPolicyVersion:   record.Revision.ContextPolicyVersion(),
		Runtime:                snapshot.Runtime,
		Enabled:                record.Enabled,
		CreatedAt:              record.CreatedAt,
		UpdatedAt:              record.UpdatedAt,
	}
}
