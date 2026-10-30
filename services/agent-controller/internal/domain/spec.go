package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"

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
	Pricing                  *ModelPricing `json:"pricing,omitempty"`
	BaseURL                  string        `json:"base_url"`
	Model                    string        `json:"model"`
	ContextWindow            int           `json:"context_window"`
	MaxOutputTokens          int           `json:"max_output_tokens"`
	Temperature              *float64      `json:"temperature,omitempty"`
	SupportsImages           bool          `json:"supports_images"`
	SupportsAudio            bool          `json:"supports_audio,omitempty"`
	SupportsPDF              bool          `json:"supports_pdf,omitempty"`
	Tokenizer                string        `json:"tokenizer,omitempty"`
	CompactionModelProfileID string        `json:"compaction_model_profile_id,omitempty"`
}

type RuntimeResources struct {
	MemoryBytes    int64  `json:"memory_bytes"`
	PIDsLimit      int    `json:"pids_limit"`
	TmpfsBytes     int64  `json:"tmpfs_bytes"`
	CPUMillis      *int64 `json:"cpu_millis,omitempty"`
	WorkspaceBytes *int64 `json:"workspace_bytes,omitempty"`
}

func (r RuntimeResources) EffectiveCPUMillis() int64 {
	if r.CPUMillis == nil {
		return 1000
	}
	return *r.CPUMillis
}

func (r RuntimeResources) EffectiveWorkspaceBytes() int64 {
	if r.WorkspaceBytes == nil {
		return 10737418240
	}
	return *r.WorkspaceBytes
}

func (r RuntimeResources) Clone() RuntimeResources {
	clone := r
	if r.CPUMillis != nil {
		value := *r.CPUMillis
		clone.CPUMillis = &value
	}
	if r.WorkspaceBytes != nil {
		value := *r.WorkspaceBytes
		clone.WorkspaceBytes = &value
	}
	return clone
}

func (r *RuntimeResources) UnmarshalJSON(raw []byte) error {
	if string(bytes.TrimSpace(raw)) == "null" {
		return errors.New("runtime resources must be an object, not null")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	for name, value := range fields {
		if string(bytes.TrimSpace(value)) == "null" {
			return fmt.Errorf("runtime resources field %q must not be null", name)
		}
	}
	type runtimeResourcesAlias RuntimeResources
	var decoded runtimeResourcesAlias
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*r = RuntimeResources(decoded)
	return nil
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
	TemplateID              string
	OrganizationID          string
	Revision                int64
	ModelProfileID          string
	FallbackModelProfileIDs []string
	SystemPrompt            string
	MaxModelRequests        int
	Runtime                 RuntimeSpecInput
	ContextPolicyVersion    string
	SkillRefs               []FrozenSkill
	SkillSetDigest          string
	ModelRetry              *ModelRetryPolicy `json:"model_retry,omitempty"`
	Failover                string            `json:"failover,omitempty"`
	RunBudget               *RunBudget        `json:"run_budget,omitempty"`
}

type SkillReference struct {
	SkillID string `json:"skill_id"`
	Version int64  `json:"version"`
}

type FrozenSkill struct {
	SkillID             string `json:"skill_id"`
	Version             int64  `json:"version"`
	Name                string `json:"name"`
	Description         string `json:"description"`
	ArtifactDigest      string `json:"artifact_digest"`
	ContentDigest       string `json:"content_digest"`
	ArtifactSize        int64  `json:"artifact_size"`
	UnpackedSize        int64  `json:"unpacked_size"`
	PackageRulesVersion int    `json:"package_rules_version"`
}

var skillIDPattern = regexp.MustCompile(`^skill_[0-9a-f]{32}$`)
var skillNamePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var skillDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func ValidSkillReference(ref SkillReference) bool {
	return skillIDPattern.MatchString(ref.SkillID) && ref.Version > 0
}

func ValidateFrozenSkills(skills []FrozenSkill) error {
	if len(skills) > 32 {
		return fmt.Errorf("too many Skill references")
	}
	ids, names := make(map[string]bool, len(skills)), make(map[string]bool, len(skills))
	var total int64
	for _, skill := range skills {
		if !skillIDPattern.MatchString(skill.SkillID) || skill.Version < 1 ||
			len(skill.Name) > 64 || !skillNamePattern.MatchString(skill.Name) ||
			strings.TrimSpace(skill.Description) == "" || len(skill.Description) > 512 ||
			!skillDigestPattern.MatchString(skill.ArtifactDigest) || !skillDigestPattern.MatchString(skill.ContentDigest) ||
			skill.ArtifactSize < 1 || skill.ArtifactSize > 8<<20 ||
			skill.UnpackedSize < 1 || skill.UnpackedSize > 32<<20 || skill.PackageRulesVersion != 1 {
			return fmt.Errorf("invalid frozen Skill metadata")
		}
		if ids[skill.SkillID] || names[skill.Name] {
			return fmt.Errorf("duplicate Skill identity or name")
		}
		ids[skill.SkillID], names[skill.Name] = true, true
		total += skill.UnpackedSize
	}
	if total > 128<<20 {
		return fmt.Errorf("skill collection exceeds 128 MiB")
	}
	return nil
}

type TemplateRevision struct {
	templateID              string
	organizationID          string
	revision                int64
	modelProfileID          string
	fallbackModelProfileIDs []string
	systemPrompt            string
	maxModelRequests        int
	runtime                 RuntimeSpecInput
	contextPolicyVersion    string
	skillRefs               []FrozenSkill
	skillSetDigest          string
	modelRetry              *ModelRetryPolicy
	failover                string
	runBudget               *RunBudget
}

type TemplateRevisionSnapshot struct {
	TemplateID              string            `json:"template_id"`
	OrganizationID          string            `json:"organization_id"`
	Revision                int64             `json:"revision"`
	ModelProfileID          string            `json:"model_profile_id"`
	FallbackModelProfileIDs []string          `json:"fallback_model_profile_ids,omitempty"`
	SystemPrompt            string            `json:"system_prompt"`
	MaxModelRequests        int               `json:"max_model_requests"`
	Runtime                 RuntimeSpecInput  `json:"runtime"`
	ContextPolicyVersion    string            `json:"context_policy_version"`
	SkillRefs               []FrozenSkill     `json:"skill_refs,omitempty"`
	SkillSetDigest          string            `json:"skill_set_digest,omitempty"`
	ModelRetry              *ModelRetryPolicy `json:"model_retry,omitempty"`
	Failover                string            `json:"failover,omitempty"`
	RunBudget               *RunBudget        `json:"run_budget,omitempty"`
}

func NewTemplateRevision(input TemplateRevisionInput) (TemplateRevision, error) {
	if err := ValidateModelCallPolicy(input.ModelRetry, input.Failover, input.RunBudget); err != nil {
		return TemplateRevision{}, err
	}
	if strings.TrimSpace(input.TemplateID) == "" || strings.TrimSpace(input.OrganizationID) == "" || input.Revision < 1 {
		return TemplateRevision{}, fmt.Errorf("template revision identity is invalid")
	}
	if strings.TrimSpace(input.ModelProfileID) == "" {
		return TemplateRevision{}, fmt.Errorf("model profile is required")
	}
	if err := ValidateModelFallback(input.ModelProfileID, input.FallbackModelProfileIDs); err != nil {
		return TemplateRevision{}, err
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
	if err := ValidateFrozenSkills(input.SkillRefs); err != nil {
		return TemplateRevision{}, err
	}
	skillSetDigest, err := SkillSetDigest(input.OrganizationID, input.SkillRefs)
	if err != nil {
		return TemplateRevision{}, err
	}
	if input.SkillSetDigest != "" && input.SkillSetDigest != skillSetDigest {
		return TemplateRevision{}, fmt.Errorf("skill collection digest does not match frozen metadata")
	}
	// The catalog persists an empty collection as []; keep construction and replay identical.
	orderedSkills := append([]FrozenSkill{}, input.SkillRefs...)
	slices.SortFunc(orderedSkills, func(left, right FrozenSkill) int {
		return strings.Compare(left.SkillID, right.SkillID)
	})
	return TemplateRevision{
		templateID: input.TemplateID, organizationID: input.OrganizationID,
		revision: input.Revision, modelProfileID: input.ModelProfileID,
		fallbackModelProfileIDs: append([]string(nil), input.FallbackModelProfileIDs...),
		systemPrompt:            input.SystemPrompt, maxModelRequests: input.MaxModelRequests,
		runtime: cloneRuntime(input.Runtime), contextPolicyVersion: input.ContextPolicyVersion,
		skillRefs: orderedSkills, skillSetDigest: skillSetDigest,
		modelRetry: input.ModelRetry.Clone(), failover: input.Failover, runBudget: input.RunBudget.Clone(),
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
		FallbackModelProfileIDs: slices.Clone(revision.fallbackModelProfileIDs),
		SystemPrompt:            revision.systemPrompt, MaxModelRequests: revision.maxModelRequests,
		Runtime: cloneRuntime(revision.runtime), ContextPolicyVersion: revision.contextPolicyVersion,
		SkillRefs: slices.Clone(revision.skillRefs), SkillSetDigest: revision.skillSetDigest,
		ModelRetry: revision.modelRetry.Clone(), Failover: revision.failover, RunBudget: revision.runBudget.Clone(),
	}
}

type AgentSpecSnapshot struct {
	ModelProfileID          string            `json:"model_profile_id"`
	FallbackModelProfileIDs []string          `json:"fallback_model_profile_ids,omitempty"`
	ModelProfileVersion     int64             `json:"model_profile_version"`
	TemplateID              string            `json:"template_id"`
	TemplateRevision        int64             `json:"template_revision"`
	ModelProfileRevisionID  string            `json:"model_profile_revision_id"`
	SystemPrompt            string            `json:"system_prompt"`
	MaxModelRequests        int               `json:"max_model_requests"`
	ContextPolicyVersion    string            `json:"context_policy_version"`
	Model                   ModelSpec         `json:"model"`
	Runtime                 RuntimeSpecInput  `json:"runtime"`
	SystemSkills            []FrozenSkill     `json:"system_skills,omitempty"`
	SkillSetDigest          string            `json:"skill_set_digest,omitempty"`
	ModelRetry              *ModelRetryPolicy `json:"model_retry,omitempty"`
	Failover                string            `json:"failover,omitempty"`
	RunBudget               *RunBudget        `json:"run_budget,omitempty"`
}

type AgentSpec struct{ snapshot AgentSpecSnapshot }

func MaterializeAgentSpec(template TemplateRevision, model ModelProfileRevision) (AgentSpec, error) {
	if template.organizationID != model.organizationID {
		return AgentSpec{}, fmt.Errorf("template and model profile belong to different organizations")
	}
	if template.modelProfileID != model.modelProfileID {
		return AgentSpec{}, fmt.Errorf("template references a different model profile")
	}
	skillSetDigest := template.skillSetDigest
	if len(template.skillRefs) == 0 {
		var err error
		skillSetDigest, err = SkillSetDigest(template.organizationID, []FrozenSkill{})
		if err != nil {
			return AgentSpec{}, fmt.Errorf("digest empty Skill collection: %w", err)
		}
	}
	return AgentSpec{snapshot: AgentSpecSnapshot{
		TemplateID: template.templateID, TemplateRevision: template.revision,
		ModelProfileID: model.modelProfileID, ModelProfileVersion: model.revision, ModelProfileRevisionID: model.id, SystemPrompt: template.systemPrompt,
		FallbackModelProfileIDs: slices.Clone(template.fallbackModelProfileIDs),
		MaxModelRequests:        template.maxModelRequests, ContextPolicyVersion: template.contextPolicyVersion,
		Model: model.model.Clone(), Runtime: cloneRuntime(template.runtime),
		SystemSkills:   slices.Clone(template.skillRefs),
		SkillSetDigest: skillSetDigest,
		ModelRetry:     template.modelRetry.Clone(), Failover: template.failover, RunBudget: template.runBudget.Clone(),
	}}, nil
}

func (spec AgentSpec) Snapshot() AgentSpecSnapshot {
	snapshot := spec.snapshot
	snapshot.FallbackModelProfileIDs = slices.Clone(snapshot.FallbackModelProfileIDs)
	snapshot.Model = snapshot.Model.Clone()
	snapshot.Runtime = cloneRuntime(snapshot.Runtime)
	snapshot.SystemSkills = slices.Clone(snapshot.SystemSkills)
	snapshot.ModelRetry = snapshot.ModelRetry.Clone()
	snapshot.RunBudget = snapshot.RunBudget.Clone()
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
	switch model.Tokenizer {
	case "", "o200k", "cl100k", "none":
	default:
		return fmt.Errorf("model tokenizer is unsupported")
	}
	if len(model.CompactionModelProfileID) > 200 ||
		strings.IndexFunc(model.CompactionModelProfileID, unicode.IsSpace) >= 0 {
		return fmt.Errorf("compaction model profile reference is invalid")
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
	if resources.CPUMillis != nil && (*resources.CPUMillis < 100 || *resources.CPUMillis > 16000) {
		return fmt.Errorf("runtime cpu_millis must be between 100 and 16000")
	}
	if resources.WorkspaceBytes != nil && (*resources.WorkspaceBytes < 67108864 || *resources.WorkspaceBytes > 1099511627776) {
		return fmt.Errorf("runtime workspace_bytes must be between %d and %d", int64(67108864), int64(1099511627776))
	}
	return validateMCPServers(runtime.MCPServers)
}

func (model ModelSpec) Clone() ModelSpec {
	clone := model
	clone.Temperature = cloneFloat(model.Temperature)
	clone.Pricing = model.Pricing.clone()
	return clone
}
