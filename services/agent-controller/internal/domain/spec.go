package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const (
	ContextPolicyV1      = "context-v1"
	minimumContextWindow = 1024
	maximumModelRequests = 128
	minimumMemoryBytes   = 128 * 1024 * 1024
	minimumPIDs          = 16
	maximumPIDs          = 32768
	minimumTmpfsBytes    = 16 * 1024 * 1024
)

var immutableImagePattern = regexp.MustCompile(`^(?:sha256:[0-9a-fA-F]{64}|[^@\s]+@sha256:[0-9a-fA-F]{64})$`)

type ModelSpec struct {
	BaseURL         string   `json:"base_url"`
	Model           string   `json:"model"`
	ContextWindow   int      `json:"context_window"`
	MaxOutputTokens int      `json:"max_output_tokens"`
	Temperature     *float64 `json:"temperature,omitempty"`
	SupportsImages  bool     `json:"supports_images"`
}

type RuntimeResources struct {
	MemoryBytes int64 `json:"memory_bytes"`
	PIDsLimit   int   `json:"pids_limit"`
	TmpfsBytes  int64 `json:"tmpfs_bytes"`
}

type RuntimeSpecInput struct {
	ImageRef  string           `json:"image_ref"`
	Resources RuntimeResources `json:"resources"`
}

type ModelProfileRevisionInput struct {
	ID                string
	ModelProfileID    string
	OrganizationID    string
	Revision          int64
	Model             ModelSpec
	CredentialRef     string
	CredentialVersion string
}

type ModelProfileRevision struct {
	id                string
	modelProfileID    string
	organizationID    string
	revision          int64
	model             ModelSpec
	credentialRef     string
	credentialVersion string
}

type ModelProfileRevisionSnapshot struct {
	ID                string    `json:"id"`
	ModelProfileID    string    `json:"model_profile_id"`
	OrganizationID    string    `json:"organization_id"`
	Revision          int64     `json:"revision"`
	Model             ModelSpec `json:"model"`
	CredentialRef     string    `json:"credential_ref"`
	CredentialVersion string    `json:"credential_version"`
}

func NewModelProfileRevision(input ModelProfileRevisionInput) (ModelProfileRevision, error) {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.ModelProfileID) == "" ||
		strings.TrimSpace(input.OrganizationID) == "" || input.Revision < 1 {
		return ModelProfileRevision{}, fmt.Errorf("model revision identity is invalid")
	}
	if strings.TrimSpace(input.CredentialRef) == "" || strings.TrimSpace(input.CredentialVersion) == "" {
		return ModelProfileRevision{}, fmt.Errorf("model revision credential is required")
	}
	if err := validateModel(input.Model); err != nil {
		return ModelProfileRevision{}, err
	}
	return ModelProfileRevision{
		id: input.ID, modelProfileID: input.ModelProfileID,
		organizationID: input.OrganizationID, revision: input.Revision,
		model: cloneModel(input.Model), credentialRef: input.CredentialRef,
		credentialVersion: input.CredentialVersion,
	}, nil
}

func (revision ModelProfileRevision) ID() string { return revision.id }

func (revision ModelProfileRevision) OrganizationID() string { return revision.organizationID }

func (revision ModelProfileRevision) Revision() int64 { return revision.revision }

func (revision ModelProfileRevision) Snapshot() ModelProfileRevisionSnapshot {
	return ModelProfileRevisionSnapshot{
		ID: revision.id, ModelProfileID: revision.modelProfileID,
		OrganizationID: revision.organizationID, Revision: revision.revision,
		Model: cloneModel(revision.model), CredentialRef: revision.credentialRef,
		CredentialVersion: revision.credentialVersion,
	}
}

type TemplateRevisionInput struct {
	TemplateID             string
	OrganizationID         string
	Revision               int64
	ModelProfileRevisionID string
	SystemPrompt           string
	MaxModelRequests       int
	Runtime                RuntimeSpecInput
	ContextPolicyVersion   string
}

type TemplateRevision struct {
	templateID             string
	organizationID         string
	revision               int64
	modelProfileRevisionID string
	systemPrompt           string
	maxModelRequests       int
	runtime                RuntimeSpecInput
	contextPolicyVersion   string
}

type TemplateRevisionSnapshot struct {
	TemplateID             string           `json:"template_id"`
	OrganizationID         string           `json:"organization_id"`
	Revision               int64            `json:"revision"`
	ModelProfileRevisionID string           `json:"model_profile_revision_id"`
	SystemPrompt           string           `json:"system_prompt"`
	MaxModelRequests       int              `json:"max_model_requests"`
	Runtime                RuntimeSpecInput `json:"runtime"`
	ContextPolicyVersion   string           `json:"context_policy_version"`
}

func NewTemplateRevision(input TemplateRevisionInput) (TemplateRevision, error) {
	if strings.TrimSpace(input.TemplateID) == "" || strings.TrimSpace(input.OrganizationID) == "" || input.Revision < 1 {
		return TemplateRevision{}, fmt.Errorf("template revision identity is invalid")
	}
	if strings.TrimSpace(input.ModelProfileRevisionID) == "" {
		return TemplateRevision{}, fmt.Errorf("model profile revision is required")
	}
	if input.MaxModelRequests < 1 || input.MaxModelRequests > maximumModelRequests {
		return TemplateRevision{}, fmt.Errorf("max model requests must be between 1 and %d", maximumModelRequests)
	}
	if input.ContextPolicyVersion != ContextPolicyV1 {
		return TemplateRevision{}, fmt.Errorf("unsupported context policy version %q", input.ContextPolicyVersion)
	}
	if err := validateRuntime(input.Runtime); err != nil {
		return TemplateRevision{}, err
	}
	return TemplateRevision{
		templateID: input.TemplateID, organizationID: input.OrganizationID,
		revision: input.Revision, modelProfileRevisionID: input.ModelProfileRevisionID,
		systemPrompt: input.SystemPrompt, maxModelRequests: input.MaxModelRequests,
		runtime: input.Runtime, contextPolicyVersion: input.ContextPolicyVersion,
	}, nil
}

func (revision TemplateRevision) Revision() int64 { return revision.revision }

func (revision TemplateRevision) ModelProfileRevisionID() string {
	return revision.modelProfileRevisionID
}

func (revision TemplateRevision) ContextPolicyVersion() string {
	return revision.contextPolicyVersion
}

func (revision TemplateRevision) Snapshot() TemplateRevisionSnapshot {
	return TemplateRevisionSnapshot{
		TemplateID: revision.templateID, OrganizationID: revision.organizationID,
		Revision: revision.revision, ModelProfileRevisionID: revision.modelProfileRevisionID,
		SystemPrompt: revision.systemPrompt, MaxModelRequests: revision.maxModelRequests,
		Runtime: revision.runtime, ContextPolicyVersion: revision.contextPolicyVersion,
	}
}

type AgentSpecSnapshot struct {
	TemplateID             string           `json:"template_id"`
	TemplateRevision       int64            `json:"template_revision"`
	ModelProfileRevisionID string           `json:"model_profile_revision_id"`
	SystemPrompt           string           `json:"system_prompt"`
	MaxModelRequests       int              `json:"max_model_requests"`
	ContextPolicyVersion   string           `json:"context_policy_version"`
	CredentialRef          string           `json:"credential_ref"`
	CredentialVersion      string           `json:"credential_version"`
	Model                  ModelSpec        `json:"model"`
	Runtime                RuntimeSpecInput `json:"runtime"`
}

type AgentSpec struct{ snapshot AgentSpecSnapshot }

func MaterializeAgentSpec(template TemplateRevision, model ModelProfileRevision) (AgentSpec, error) {
	if template.organizationID != model.organizationID {
		return AgentSpec{}, fmt.Errorf("template and model profile belong to different organizations")
	}
	if template.modelProfileRevisionID != model.id {
		return AgentSpec{}, fmt.Errorf("template references a different model profile revision")
	}
	return AgentSpec{snapshot: AgentSpecSnapshot{
		TemplateID: template.templateID, TemplateRevision: template.revision,
		ModelProfileRevisionID: model.id, SystemPrompt: template.systemPrompt,
		MaxModelRequests: template.maxModelRequests, ContextPolicyVersion: template.contextPolicyVersion,
		CredentialRef: model.credentialRef, CredentialVersion: model.credentialVersion,
		Model: cloneModel(model.model), Runtime: template.runtime,
	}}, nil
}

func (spec AgentSpec) Snapshot() AgentSpecSnapshot {
	snapshot := spec.snapshot
	snapshot.Model = cloneModel(snapshot.Model)
	return snapshot
}

func (spec AgentSpec) Digest() (string, error) {
	payload, err := json.Marshal(spec.Snapshot())
	if err != nil {
		return "", fmt.Errorf("encode Agent spec: %w", err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}

func validateModel(model ModelSpec) error {
	endpoint, err := url.Parse(model.BaseURL)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return fmt.Errorf("model base URL must be an HTTP URL without credentials, query, or fragment")
	}
	if strings.TrimSpace(model.Model) == "" || model.ContextWindow < minimumContextWindow || model.MaxOutputTokens < 1 {
		return fmt.Errorf("model limits or identity are invalid")
	}
	if model.Temperature != nil && (*model.Temperature < 0 || *model.Temperature > 2) {
		return fmt.Errorf("temperature must be between 0 and 2")
	}
	return nil
}

func ValidateModelSpec(model ModelSpec) error {
	return validateModel(model)
}

func validateRuntime(runtime RuntimeSpecInput) error {
	if !immutableImagePattern.MatchString(runtime.ImageRef) {
		return fmt.Errorf("runtime image must be immutable")
	}
	resources := runtime.Resources
	if resources.MemoryBytes < minimumMemoryBytes || resources.TmpfsBytes < minimumTmpfsBytes {
		return fmt.Errorf("runtime memory or tmpfs is below minimum")
	}
	if resources.PIDsLimit < minimumPIDs || resources.PIDsLimit > maximumPIDs {
		return fmt.Errorf("runtime PID limit must be between %d and %d", minimumPIDs, maximumPIDs)
	}
	return nil
}

func cloneModel(model ModelSpec) ModelSpec {
	clone := model
	if model.Temperature != nil {
		value := *model.Temperature
		clone.Temperature = &value
	}
	return clone
}
