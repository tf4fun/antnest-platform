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

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var (
	ErrInvalidInput     = errors.New("invalid input")
	ErrInvalidReference = errors.New("invalid reference")
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
	sealed, err := service.sealer.Seal(ctx, input.CredentialSecret)
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("seal Provider credential: %w", err)
	}
	record, err := service.store.PutModelProfile(ctx, ports.ModelProfileRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		ModelProfileID: profileID, OrganizationID: input.OrganizationID,
		ProfileKey: input.ProfileKey, DisplayName: input.DisplayName,
		Revision: revision, CredentialRef: credentialRef,
		CredentialVersion: credentialVersion, SealedCredential: sealed,
		CreatedAt: service.clock.Now(),
	})
	if err != nil {
		return ModelProfileView{}, fmt.Errorf("persist ModelProfile: %w", err)
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
	ContextPolicyVersion   string
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
	record, err := service.store.PutTemplate(ctx, ports.TemplateRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		TemplateID: templateID, OrganizationID: input.OrganizationID,
		TemplateKey: input.TemplateKey, Name: input.Name, Revision: revision,
		CreatedAt: service.clock.Now(),
	})
	if err != nil {
		return TemplateView{}, fmt.Errorf("persist Template: %w", err)
	}
	return templateView(record), nil
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
	return ModelProfileView{
		ModelProfileID: record.ModelProfileID, OrganizationID: record.OrganizationID,
		ProfileKey: record.ProfileKey, DisplayName: record.DisplayName,
		RevisionID: record.Revision.ID(), Revision: record.Revision.Revision(),
		CredentialRef: record.CredentialRef, CredentialVersion: record.CredentialVersion,
	}
}

func templateView(record ports.TemplateRecord) TemplateView {
	return TemplateView{
		TemplateID: record.TemplateID, OrganizationID: record.OrganizationID,
		TemplateKey: record.TemplateKey, Name: record.Name,
		Revision:               record.Revision.Revision(),
		ModelProfileRevisionID: record.Revision.ModelProfileRevisionID(),
		ContextPolicyVersion:   record.Revision.ContextPolicyVersion(),
	}
}
