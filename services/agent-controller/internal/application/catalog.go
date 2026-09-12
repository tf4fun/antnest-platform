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
	"unicode/utf8"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var (
	ErrInvalidInput      = errors.New("invalid input")
	ErrInvalidReference  = errors.New("invalid reference")
	ErrAgentNotFound     = errors.New("agent not found")
	ErrAgentNotReady     = errors.New("agent not ready")
	ErrLifecycleConflict = errors.New("lifecycle conflict")
)

const (
	defaultCatalogPageSize        = 100
	maximumCatalogPageSize        = 500
	maximumModelDisplayNameLength = 200
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
	RequestID            string
	OrganizationID       string
	ProfileKey           string
	DisplayName          string
	Model                domain.ModelParameters
	ProviderConnectionID string
}

type ModelProfileView struct {
	ProviderConnectionID string
	ModelProfileID       string
	OrganizationID       string
	ProfileKey           string
	DisplayName          string
	RevisionID           string
	Revision             int64
	Enabled              bool
	Model                domain.ModelSpec
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

func (service *CatalogService) CreateModelProfile(ctx context.Context, input CreateModelProfileInput) (ModelProfileView, error) {
	if err := validateModelProfileInput(input); err != nil {
		return ModelProfileView{}, err
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ModelProfileView{}, err
	}
	replayed, found, err := service.store.ReplayModelProfileRequest(
		ctx, ports.CreateModelProfileRequest, input.RequestID, fingerprint,
	)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("replay ModelProfile request: %w", err)
	}
	if found {
		return modelProfileView(replayed), nil
	}
	connection, err := service.loadEnabledProvider(ctx, input.OrganizationID, input.ProviderConnectionID)
	if err != nil {
		return ModelProfileView{}, err
	}
	record, err := newProviderModel(connection, input.RequestID, ProviderModelInput{
		ProfileKey: input.ProfileKey, DisplayName: input.DisplayName, Model: input.Model,
	}, 1, derivedID("model", input.RequestID))
	if err != nil {
		return ModelProfileView{}, err
	}
	record.RequestID, record.RequestFingerprint = input.RequestID, fingerprint
	record.CreatedAt, record.UpdatedAt = service.clock.Now(), service.clock.Now()
	record, err = service.store.PutModelProfile(ctx, record)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("persist ModelProfile: %w", err)
	}
	return modelProfileView(record), nil
}

type ReviseModelProfileInput struct {
	RequestID       string
	OrganizationID  string
	ModelProfileID  string
	ExpectedVersion int64
	DisplayName     string
	Model           domain.ModelParameters
}

func (service *CatalogService) ReviseModelProfile(
	ctx context.Context, input ReviseModelProfileInput,
) (ModelProfileView, error) {
	if err := input.Model.Pricing.Validate(); err != nil {
		return ModelProfileView{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) ||
		!validIdentifier(input.ModelProfileID) || input.ExpectedVersion < 1 ||
		!validModelDisplayName(input.DisplayName) {
		return ModelProfileView{}, fmt.Errorf("%w: ModelProfile revision input", ErrInvalidInput)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ModelProfileView{}, err
	}
	replayed, found, err := service.store.ReplayModelProfileRequest(
		ctx, ports.ReviseModelProfileRequest, input.RequestID, fingerprint,
	)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("replay ModelProfile revision request: %w", err)
	}
	if found {
		return modelProfileView(replayed), nil
	}
	current, err := service.store.GetModelProfile(ctx, input.ModelProfileID)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("load ModelProfile: %w", err)
	}
	if current.OrganizationID != input.OrganizationID {
		return ModelProfileView{}, fmt.Errorf("%w: ModelProfile belongs to another organization", ErrInvalidReference)
	}
	if input.Model.Model != current.Revision.Snapshot().Model.Model {
		return ModelProfileView{}, fmt.Errorf("%w: API model identity cannot be changed", ErrInvalidInput)
	}
	connection, err := service.loadEnabledProvider(ctx, input.OrganizationID, current.ProviderConnectionID)
	if err != nil {
		return ModelProfileView{}, err
	}
	record, err := newProviderModel(connection, input.RequestID, ProviderModelInput{
		ProfileKey: current.ProfileKey, DisplayName: input.DisplayName, Model: input.Model,
	}, input.ExpectedVersion+1, current.ModelProfileID)
	if err != nil {
		return ModelProfileView{}, err
	}
	record.RequestID, record.RequestFingerprint = input.RequestID, fingerprint
	record.CreatedAt, record.UpdatedAt, record.Enabled = current.CreatedAt, service.clock.Now(), current.Enabled
	record, err = service.store.ReviseModelProfile(ctx, input.ExpectedVersion, record)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("persist ModelProfile revision: %w", err)
	}
	return modelProfileView(record), nil
}

type CreateTemplateInput struct {
	RequestID            string
	OrganizationID       string
	TemplateKey          string
	Name                 string
	ModelProfileID       string
	SystemPrompt         string
	MaxModelRequests     int
	ContextPolicyVersion string
	Runtime              domain.RuntimeSpecInput
}

type TemplateView struct {
	TemplateID           string
	OrganizationID       string
	TemplateKey          string
	Name                 string
	Revision             int64
	ModelProfileID       string
	SystemPrompt         string
	MaxModelRequests     int
	ContextPolicyVersion string
	Runtime              domain.RuntimeSpecInput
	Enabled              bool
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

func (service *CatalogService) CreateTemplate(ctx context.Context, input CreateTemplateInput) (TemplateView, error) {
	if err := validateTemplateInput(input); err != nil {
		return TemplateView{}, err
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return TemplateView{}, err
	}
	replayed, found, err := service.store.ReplayTemplateRequest(
		ctx, ports.CreateTemplateRequest, input.RequestID, fingerprint,
	)
	if err != nil {
		return TemplateView{}, fmt.Errorf("replay Template request: %w", err)
	}
	if found {
		return templateView(replayed), nil
	}
	modelRevision, err := service.store.GetCurrentModelProfileRevision(ctx, input.ModelProfileID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return TemplateView{}, fmt.Errorf("%w: ModelProfile revision", ErrInvalidReference)
		}
		return TemplateView{}, fmt.Errorf("load ModelProfile revision: %w", err)
	}
	if modelRevision.OrganizationID() != input.OrganizationID {
		return TemplateView{}, fmt.Errorf("%w: cross-organization ModelProfile", ErrInvalidReference)
	}
	templateID := derivedID("template", input.RequestID)
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: templateID, OrganizationID: input.OrganizationID, Revision: 1,
		ModelProfileID: input.ModelProfileID,
		SystemPrompt:   input.SystemPrompt, MaxModelRequests: input.MaxModelRequests,
		Runtime: input.Runtime, ContextPolicyVersion: input.ContextPolicyVersion,
	})
	if err != nil {
		return TemplateView{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
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
	RequestID            string
	OrganizationID       string
	TemplateID           string
	Name                 string
	ModelProfileID       string
	SystemPrompt         string
	MaxModelRequests     int
	ContextPolicyVersion string
	Runtime              domain.RuntimeSpecInput
}

func (service *CatalogService) ReviseTemplate(
	ctx context.Context, input ReviseTemplateInput,
) (TemplateView, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) ||
		!validIdentifier(input.TemplateID) ||
		!validIdentifier(input.ModelProfileID) || strings.TrimSpace(input.Name) == "" {
		return TemplateView{}, fmt.Errorf("%w: Template revision input", ErrInvalidInput)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return TemplateView{}, err
	}
	replayed, found, err := service.store.ReplayTemplateRequest(
		ctx, ports.ReviseTemplateRequest, input.RequestID, fingerprint,
	)
	if err != nil {
		return TemplateView{}, fmt.Errorf("replay Template revision request: %w", err)
	}
	if found {
		return templateView(replayed), nil
	}
	current, err := service.store.GetTemplate(ctx, input.TemplateID)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load Template: %w", err)
	}
	if current.OrganizationID != input.OrganizationID {
		return TemplateView{}, fmt.Errorf("%w: Template belongs to another organization", ErrInvalidReference)
	}
	modelRevision, err := service.store.GetCurrentModelProfileRevision(ctx, input.ModelProfileID)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load ModelProfile revision: %w", err)
	}
	if modelRevision.OrganizationID() != current.OrganizationID {
		return TemplateView{}, fmt.Errorf("%w: cross-organization ModelProfile", ErrInvalidReference)
	}
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: current.TemplateID, OrganizationID: current.OrganizationID,
		Revision: current.Revision.Revision() + 1, ModelProfileID: input.ModelProfileID,
		SystemPrompt: input.SystemPrompt, MaxModelRequests: input.MaxModelRequests,
		ContextPolicyVersion: input.ContextPolicyVersion, Runtime: input.Runtime,
	})
	if err != nil {
		return TemplateView{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
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

func (service *CatalogService) GetModelProfile(
	ctx context.Context, organizationID, id string,
) (ModelProfileView, error) {
	if !validIdentifier(organizationID) || !validIdentifier(id) {
		return ModelProfileView{}, fmt.Errorf("%w: ModelProfile identity", ErrInvalidInput)
	}
	record, err := service.store.GetModelProfile(ctx, id)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("load ModelProfile: %w", err)
	}
	if record.OrganizationID != organizationID {
		return ModelProfileView{}, fmt.Errorf("%w: ModelProfile belongs to another organization", ErrInvalidReference)
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

func (service *CatalogService) GetTemplate(
	ctx context.Context, organizationID, id string,
) (TemplateView, error) {
	if !validIdentifier(organizationID) || !validIdentifier(id) {
		return TemplateView{}, fmt.Errorf("%w: Template identity", ErrInvalidInput)
	}
	record, err := service.store.GetTemplate(ctx, id)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load Template: %w", err)
	}
	if record.OrganizationID != organizationID {
		return TemplateView{}, fmt.Errorf("%w: Template belongs to another organization", ErrInvalidReference)
	}
	return templateView(record), nil
}

func (service *CatalogService) GetTemplateRevision(
	ctx context.Context, organizationID, id string, revisionNumber int64,
) (TemplateView, error) {
	if !validIdentifier(organizationID) || !validIdentifier(id) || revisionNumber < 1 {
		return TemplateView{}, fmt.Errorf("%w: Template revision identity", ErrInvalidInput)
	}
	record, err := service.store.GetTemplate(ctx, id)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load Template: %w", err)
	}
	if record.OrganizationID != organizationID {
		return TemplateView{}, fmt.Errorf("%w: Template belongs to another organization", ErrInvalidReference)
	}
	revision, err := service.store.GetTemplateRevision(ctx, id, revisionNumber)
	if err != nil {
		return TemplateView{}, fmt.Errorf("load Template revision: %w", err)
	}
	snapshot := revision.Snapshot()
	if snapshot.OrganizationID != organizationID || snapshot.TemplateID != id {
		return TemplateView{}, fmt.Errorf("%w: Template revision belongs to another organization", ErrInvalidReference)
	}
	record.Revision = revision
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
	if !validModelDisplayName(input.DisplayName) || !validIdentifier(input.ProviderConnectionID) {
		return fmt.Errorf("%w: display name and Provider connection are required", ErrInvalidInput)
	}
	if err := input.Model.Pricing.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	return nil
}

func validateTemplateInput(input CreateTemplateInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) ||
		!validIdentifier(input.TemplateKey) || !validIdentifier(input.ModelProfileID) {
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

func validModelDisplayName(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= maximumModelDisplayNameLength
}

func modelProfileView(record ports.ModelProfileRecord) ModelProfileView {
	snapshot := record.Revision.Snapshot()
	return ModelProfileView{
		ProviderConnectionID: record.ProviderConnectionID,
		ModelProfileID:       record.ModelProfileID, OrganizationID: record.OrganizationID,
		ProfileKey: record.ProfileKey, DisplayName: record.DisplayName,
		RevisionID: record.Revision.ID(), Revision: record.Revision.Revision(),
		Enabled: record.Enabled, Model: snapshot.Model,
		CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
	}
}

func templateView(record ports.TemplateRecord) TemplateView {
	snapshot := record.Revision.Snapshot()
	return TemplateView{
		TemplateID: record.TemplateID, OrganizationID: record.OrganizationID,
		TemplateKey: record.TemplateKey, Name: record.Name,
		Revision:             record.Revision.Revision(),
		ModelProfileID:       record.Revision.ModelProfileID(),
		SystemPrompt:         snapshot.SystemPrompt,
		MaxModelRequests:     snapshot.MaxModelRequests,
		ContextPolicyVersion: record.Revision.ContextPolicyVersion(),
		Runtime:              snapshot.Runtime,
		Enabled:              record.Enabled,
		CreatedAt:            record.CreatedAt,
		UpdatedAt:            record.UpdatedAt,
	}
}
