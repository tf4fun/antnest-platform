package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/distribution/reference"
)

var ErrInvalidImageReference = errors.New("runtime image reference is invalid")

const (
	ContextPolicyV1      = "context-v1"
	minimumContextWindow = 1024
	maximumModelRequests = 128
	minimumMemoryBytes   = 128 * 1024 * 1024
	minimumPIDs          = 16
	maximumPIDs          = 32768
	minimumTmpfsBytes    = 16 * 1024 * 1024
)

type ModelSpec struct {
	Pricing         *ModelPricing `json:"pricing,omitempty"`
	BaseURL         string        `json:"base_url"`
	Model           string        `json:"model"`
	ContextWindow   int           `json:"context_window"`
	MaxOutputTokens int           `json:"max_output_tokens"`
	Temperature     *float64      `json:"temperature,omitempty"`
	SupportsImages  bool          `json:"supports_images"`
	SupportsAudio   bool          `json:"supports_audio,omitempty"`
	SupportsPDF     bool          `json:"supports_pdf,omitempty"`
}

type RuntimeResources struct {
	MemoryBytes int64 `json:"memory_bytes"`
	PIDsLimit   int   `json:"pids_limit"`
	TmpfsBytes  int64 `json:"tmpfs_bytes"`
}

type RuntimeSpecInput struct {
	ImageRef   string           `json:"image_ref"`
	Resources  RuntimeResources `json:"resources"`
	MCPServers []MCPServer      `json:"mcp_servers,omitempty"`
}

type ModelProfileRevisionInput struct {
	ID             string
	ModelProfileID string
	OrganizationID string
	Revision       int64
	Model          ModelSpec
}

type ModelProfileRevision struct {
	id             string
	modelProfileID string
	organizationID string
	revision       int64
	model          ModelSpec
}

type ModelProfileRevisionSnapshot struct {
	ID             string    `json:"id"`
	ModelProfileID string    `json:"model_profile_id"`
	OrganizationID string    `json:"organization_id"`
	Revision       int64     `json:"revision"`
	Model          ModelSpec `json:"model"`
}

func NewModelProfileRevision(input ModelProfileRevisionInput) (ModelProfileRevision, error) {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.ModelProfileID) == "" ||
		strings.TrimSpace(input.OrganizationID) == "" || input.Revision < 1 {
		return ModelProfileRevision{}, fmt.Errorf("model revision identity is invalid")
	}
	if err := validateModel(input.Model); err != nil {
		return ModelProfileRevision{}, err
	}
	return ModelProfileRevision{
		id: input.ID, modelProfileID: input.ModelProfileID,
		organizationID: input.OrganizationID, revision: input.Revision,
		model: input.Model.Clone(),
	}, nil
}

func (revision ModelProfileRevision) ID() string { return revision.id }

func (revision ModelProfileRevision) OrganizationID() string { return revision.organizationID }

func (revision ModelProfileRevision) Revision() int64 { return revision.revision }

func (revision ModelProfileRevision) Snapshot() ModelProfileRevisionSnapshot {
	return ModelProfileRevisionSnapshot{
		ID: revision.id, ModelProfileID: revision.modelProfileID,
		OrganizationID: revision.organizationID, Revision: revision.revision,
		Model: revision.model.Clone(),
	}
}

type TemplateRevisionInput struct {
	TemplateID           string
	OrganizationID       string
	Revision             int64
	ModelProfileID       string
	SystemPrompt         string
	MaxModelRequests     int
	Runtime              RuntimeSpecInput
	ContextPolicyVersion string
}

type TemplateRevision struct {
	templateID           string
	organizationID       string
	revision             int64
	modelProfileID       string
	systemPrompt         string
	maxModelRequests     int
	runtime              RuntimeSpecInput
	contextPolicyVersion string
}

type TemplateRevisionSnapshot struct {
	TemplateID           string           `json:"template_id"`
	OrganizationID       string           `json:"organization_id"`
	Revision             int64            `json:"revision"`
	ModelProfileID       string           `json:"model_profile_id"`
	SystemPrompt         string           `json:"system_prompt"`
	MaxModelRequests     int              `json:"max_model_requests"`
	Runtime              RuntimeSpecInput `json:"runtime"`
	ContextPolicyVersion string           `json:"context_policy_version"`
}

func NewTemplateRevision(input TemplateRevisionInput) (TemplateRevision, error) {
	if strings.TrimSpace(input.TemplateID) == "" || strings.TrimSpace(input.OrganizationID) == "" || input.Revision < 1 {
		return TemplateRevision{}, fmt.Errorf("template revision identity is invalid")
	}
	if strings.TrimSpace(input.ModelProfileID) == "" {
		return TemplateRevision{}, fmt.Errorf("model profile is required")
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
		revision: input.Revision, modelProfileID: input.ModelProfileID,
		systemPrompt: input.SystemPrompt, maxModelRequests: input.MaxModelRequests,
		runtime: cloneRuntime(input.Runtime), contextPolicyVersion: input.ContextPolicyVersion,
	}, nil
}

func (revision TemplateRevision) Revision() int64 { return revision.revision }

func (revision TemplateRevision) ModelProfileID() string {
	return revision.modelProfileID
}

func (revision TemplateRevision) ContextPolicyVersion() string {
	return revision.contextPolicyVersion
}

func (revision TemplateRevision) Snapshot() TemplateRevisionSnapshot {
	return TemplateRevisionSnapshot{
		TemplateID: revision.templateID, OrganizationID: revision.organizationID,
		Revision: revision.revision, ModelProfileID: revision.modelProfileID,
		SystemPrompt: revision.systemPrompt, MaxModelRequests: revision.maxModelRequests,
		Runtime: cloneRuntime(revision.runtime), ContextPolicyVersion: revision.contextPolicyVersion,
	}
}

type AgentSpecSnapshot struct {
	ModelProfileID         string           `json:"model_profile_id"`
	TemplateID             string           `json:"template_id"`
	TemplateRevision       int64            `json:"template_revision"`
	ModelProfileRevisionID string           `json:"model_profile_revision_id"`
	SystemPrompt           string           `json:"system_prompt"`
	MaxModelRequests       int              `json:"max_model_requests"`
	ContextPolicyVersion   string           `json:"context_policy_version"`
	Model                  ModelSpec        `json:"model"`
	Runtime                RuntimeSpecInput `json:"runtime"`
}

type AgentSpec struct{ snapshot AgentSpecSnapshot }

func MaterializeAgentSpec(template TemplateRevision, model ModelProfileRevision) (AgentSpec, error) {
	if template.organizationID != model.organizationID {
		return AgentSpec{}, fmt.Errorf("template and model profile belong to different organizations")
	}
	if template.modelProfileID != model.modelProfileID {
		return AgentSpec{}, fmt.Errorf("template references a different model profile")
	}
	return AgentSpec{snapshot: AgentSpecSnapshot{
		TemplateID: template.templateID, TemplateRevision: template.revision,
		ModelProfileID: model.modelProfileID, ModelProfileRevisionID: model.id, SystemPrompt: template.systemPrompt,
		MaxModelRequests: template.maxModelRequests, ContextPolicyVersion: template.contextPolicyVersion,
		Model: model.model.Clone(), Runtime: cloneRuntime(template.runtime),
	}}, nil
}

func (spec AgentSpec) Snapshot() AgentSpecSnapshot {
	snapshot := spec.snapshot
	snapshot.Model = snapshot.Model.Clone()
	snapshot.Runtime = cloneRuntime(snapshot.Runtime)
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
	return model.Pricing.Validate()
}

func ValidateModelSpec(model ModelSpec) error {
	return validateModel(model)
}

func validateRuntime(runtime RuntimeSpecInput) error {
	if runtime.ImageRef == "" || len(runtime.ImageRef) > 512 || strings.TrimSpace(runtime.ImageRef) != runtime.ImageRef {
		return ErrInvalidImageReference
	}
	if _, err := reference.ParseAnyReference(runtime.ImageRef); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidImageReference, err)
	}
	resources := runtime.Resources
	if resources.MemoryBytes < minimumMemoryBytes || resources.TmpfsBytes < minimumTmpfsBytes {
		return fmt.Errorf("runtime memory or tmpfs is below minimum")
	}
	if resources.PIDsLimit < minimumPIDs || resources.PIDsLimit > maximumPIDs {
		return fmt.Errorf("runtime PID limit must be between %d and %d", minimumPIDs, maximumPIDs)
	}
	return validateMCPServers(runtime.MCPServers)
}

func (model ModelSpec) Clone() ModelSpec {
	clone := model
	clone.Temperature = cloneFloat(model.Temperature)
	clone.Pricing = model.Pricing.clone()
	return clone
}
