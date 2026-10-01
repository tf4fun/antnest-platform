package registry

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const MaxDiscoveryLimit = 50
const MaxSourceSequence int64 = 9007199254740991

var agentID = regexp.MustCompile("^agent_[0-9a-f]{32}$")
var contentDigest = regexp.MustCompile("^sha256:[0-9a-f]{64}$")

type Projection struct {
	OrganizationID string `json:"organization_id"`
	AgentID        string `json:"agent_id"`
	OwnerID        string `json:"owner_id"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	Sequence       int64  `json:"sequence"`
	ContentDigest  string `json:"content_digest"`
	Active         bool   `json:"active"`
}
type ProjectionResult struct {
	Outcome  string `json:"outcome"`
	Sequence int64  `json:"sequence"`
}
type SourceKey struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name"`
}
type SkillRef struct {
	Kind     string `json:"kind"`
	AgentID  string `json:"agent_id,omitempty"`
	Name     string `json:"name,omitempty"`
	Sequence int64  `json:"sequence,omitempty"`
	SkillID  string `json:"skill_id,omitempty"`
	Version  int64  `json:"version,omitempty"`
}

func (ref *SkillRef) UnmarshalJSON(data []byte) error {
	var kind struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(data, &kind); err != nil {
		return err
	}
	switch kind.Kind {
	case "agent":
		var value struct {
			Kind     string `json:"kind"`
			AgentID  string `json:"agent_id"`
			Name     string `json:"name"`
			Sequence int64  `json:"sequence"`
		}
		if err := decodeOne(data, &value); err != nil {
			return err
		}
		*ref = SkillRef{Kind: value.Kind, AgentID: value.AgentID, Name: value.Name, Sequence: value.Sequence}
	case "registry":
		var value struct {
			Kind    string `json:"kind"`
			SkillID string `json:"skill_id"`
			Version int64  `json:"version"`
		}
		if err := decodeOne(data, &value); err != nil {
			return err
		}
		*ref = SkillRef{Kind: value.Kind, SkillID: value.SkillID, Version: value.Version}
	default:
		return failure("invalid_request", "unknown Skill source")
	}
	return nil
}

type DiscoveryItem struct {
	SkillRef      SkillRef `json:"skill_ref"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	ContentDigest string   `json:"content_digest"`
}
type SearchInput struct {
	OrganizationID    string `json:"organization_id"`
	ActorID           string `json:"actor_id"`
	RequestingAgentID string `json:"requesting_agent_id,omitempty"`
	Query             string `json:"query"`
	Limit             int    `json:"limit,omitempty"`
}
type LoadInput struct {
	OrganizationID string   `json:"organization_id"`
	ActorID        string   `json:"actor_id"`
	SkillRef       SkillRef `json:"skill_ref"`
	ExpectedDigest string   `json:"expected_digest"`
}
type SourceArtifactInput = LoadInput
type PromoteInput struct {
	RequestID       string   `json:"request_id"`
	OrganizationID  string   `json:"organization_id"`
	ActorID         string   `json:"actor_id"`
	SkillRef        SkillRef `json:"skill_ref"`
	ExpectedDigest  string   `json:"expected_digest"`
	SkillID         string   `json:"skill_id,omitempty"`
	ExpectedVersion int64    `json:"expected_version,omitempty"`
}
type SourceProvenance struct {
	OrganizationID string   `json:"organization_id"`
	SkillRef       SkillRef `json:"skill_ref"`
	ContentDigest  string   `json:"content_digest"`
}
type LoadedPackage struct {
	SkillRef SkillRef
	Package  Package
}
type ProjectionStore interface {
	UpsertProjection(context.Context, Projection) (ProjectionResult, error)
	GetProjection(context.Context, string, string, string) (Projection, error)
	SearchCandidates(context.Context, SearchInput) ([]DiscoveryItem, error)
}
type AgentSkillSource interface {
	Inspect(context.Context, string, string, []SourceKey) ([]Projection, error)
	Artifact(context.Context, SourceArtifactInput) ([]byte, error)
}
type Discovery struct {
	service *Service
	index   ProjectionStore
	source  AgentSkillSource
}

func NewDiscovery(service *Service, index ProjectionStore, source AgentSkillSource) *Discovery {
	return &Discovery{service: service, index: index, source: source}
}

func validSkillName(name string) bool {
	return len(name) >= 1 && len(name) <= 64 && namePattern.MatchString(name)
}
func validProjection(p Projection) bool {
	return organizationID.MatchString(p.OrganizationID) && agentID.MatchString(p.AgentID) && userID.MatchString(p.OwnerID) &&
		validSkillName(p.Name) && len(p.Description) >= 1 && len(p.Description) <= 512 && utf8.ValidString(p.Description) &&
		strings.TrimSpace(p.Description) == p.Description && !strings.ContainsRune(p.Description, 0) &&
		p.Sequence >= 1 && p.Sequence <= MaxSourceSequence && contentDigest.MatchString(p.ContentDigest)
}
func validRef(ref SkillRef) bool {
	switch ref.Kind {
	case "agent":
		return agentID.MatchString(ref.AgentID) && validSkillName(ref.Name) && ref.Sequence >= 1 && ref.Sequence <= MaxSourceSequence && ref.SkillID == "" && ref.Version == 0
	case "registry":
		return skillID.MatchString(ref.SkillID) && ref.Version >= 1 && ref.AgentID == "" && ref.Name == "" && ref.Sequence == 0
	}
	return false
}
func matchesQuery(name, description, query string) bool {
	return strings.Contains(strings.ToLower(name+" "+description), strings.ToLower(query))
}
func projectionItem(p Projection) DiscoveryItem {
	return DiscoveryItem{
		SkillRef: SkillRef{Kind: "agent", AgentID: p.AgentID, Name: p.Name, Sequence: p.Sequence},
		Name:     p.Name, Description: p.Description, ContentDigest: p.ContentDigest}
}
func discoveryOrder(item DiscoveryItem) string {
	return item.Name + "\x00" + item.SkillRef.Kind + "\x00" + item.SkillRef.AgentID + item.SkillRef.SkillID
}
func (d *Discovery) Update(ctx context.Context, p Projection) (ProjectionResult, error) {
	if !validProjection(p) {
		return ProjectionResult{}, failure("invalid_request", "invalid source mapping")
	}
	return d.index.UpsertProjection(ctx, p)
}
func (d *Discovery) Search(ctx context.Context, in SearchInput) ([]DiscoveryItem, error) {
	in.Query = strings.TrimSpace(in.Query)
	if !organizationID.MatchString(in.OrganizationID) || !userID.MatchString(in.ActorID) || len(in.Query) < 1 || len(in.Query) > 256 || !utf8.ValidString(in.Query) || strings.ContainsRune(in.Query, 0) || in.Limit < 0 || in.Limit > MaxDiscoveryLimit {
		return nil, failure("invalid_request", "invalid discovery identity, query or limit")
	}
	if in.RequestingAgentID != "" && !agentID.MatchString(in.RequestingAgentID) {
		return nil, failure("invalid_request", "invalid requesting Agent identity")
	}
	if in.Limit == 0 {
		in.Limit = 20
	}
	candidates, err := d.index.SearchCandidates(ctx, in)
	if err != nil {
		return nil, err
	}
	keys := make([]SourceKey, 0, len(candidates))
	wanted := map[SourceKey]bool{}
	for _, item := range candidates {
		if item.SkillRef.Kind == "agent" {
			if item.SkillRef.AgentID == in.RequestingAgentID {
				continue
			}
			key := SourceKey{AgentID: item.SkillRef.AgentID, Name: item.Name}
			if !wanted[key] {
				keys = append(keys, key)
				wanted[key] = true
			}
		}
	}
	current := map[SourceKey]Projection{}
	if len(keys) > 0 {
		if d.source == nil {
			return nil, failure("source_unavailable", "Agent Skill source is unavailable")
		}
		items, err := d.source.Inspect(ctx, in.OrganizationID, in.ActorID, keys)
		if err != nil {
			return nil, sourceFailure(err)
		}
		if len(items) > len(keys) {
			return nil, failure("source_invalid", "invalid source inspection")
		}
		for _, p := range items {
			key := SourceKey{AgentID: p.AgentID, Name: p.Name}
			if !validProjection(p) || !p.Active || p.OrganizationID != in.OrganizationID || p.OwnerID != in.ActorID || !wanted[key] {
				return nil, failure("source_invalid", "invalid source inspection")
			}
			if _, duplicate := current[key]; duplicate {
				return nil, failure("source_invalid", "repeated source inspection")
			}
			current[key] = p
		}
	}
	out := make([]DiscoveryItem, 0, len(candidates))
	for _, item := range candidates {
		if item.SkillRef.Kind == "agent" {
			if item.SkillRef.AgentID == in.RequestingAgentID {
				continue
			}
			p, ok := current[SourceKey{AgentID: item.SkillRef.AgentID, Name: item.Name}]
			if !ok {
				continue
			}
			if p.Sequence < item.SkillRef.Sequence {
				return nil, failure("source_invalid", "source inspection is behind its mapping")
			}
			item = projectionItem(p)
		}
		if matchesQuery(item.Name, item.Description, in.Query) {
			out = append(out, item)
		}
	}
	sort.Slice(out, func(i, j int) bool { return discoveryOrder(out[i]) < discoveryOrder(out[j]) })
	if len(out) > in.Limit {
		out = out[:in.Limit]
	}
	return out, nil
}
func sourceFailure(err error) error {
	switch Code(err) {
	case "not_found":
		return failure("not_found", "Skill source not found")
	case "content_changed":
		return failure("content_changed", "Skill source content changed; choose again")
	case "source_invalid":
		return failure("source_invalid", "Skill source returned invalid content")
	default:
		return failure("source_unavailable", "Agent Skill source is unavailable")
	}
}
func (d *Discovery) Load(ctx context.Context, in LoadInput) (LoadedPackage, error) {
	if !organizationID.MatchString(in.OrganizationID) || !userID.MatchString(in.ActorID) || !validRef(in.SkillRef) || !contentDigest.MatchString(in.ExpectedDigest) {
		return LoadedPackage{}, failure("invalid_request", "invalid selected Skill identity")
	}
	var artifact []byte
	if in.SkillRef.Kind == "registry" {
		_, data, err := d.service.Artifact(ctx, in.OrganizationID, in.SkillRef.SkillID, in.SkillRef.Version)
		if err != nil {
			return LoadedPackage{}, err
		}
		artifact = data
	} else {
		p, err := d.index.GetProjection(ctx, in.OrganizationID, in.SkillRef.AgentID, in.SkillRef.Name)
		if err != nil {
			return LoadedPackage{}, err
		}
		if !p.Active || p.OwnerID != in.ActorID {
			return LoadedPackage{}, failure("not_found", "Skill source not found")
		}
		if p.Sequence > in.SkillRef.Sequence {
			return LoadedPackage{}, failure("content_changed", "Skill source content changed; choose again")
		}
		if d.source == nil {
			return LoadedPackage{}, failure("source_unavailable", "Agent Skill source is unavailable")
		}
		artifact, err = d.source.Artifact(ctx, in)
		if err != nil {
			return LoadedPackage{}, sourceFailure(err)
		}
	}
	pkg, err := ValidatePackage(ctx, artifact)
	if err != nil {
		if ctx.Err() != nil {
			return LoadedPackage{}, ctx.Err()
		}
		return LoadedPackage{}, failure("source_invalid", "selected Skill package is invalid")
	}
	if pkg.ContentDigest != in.ExpectedDigest || in.SkillRef.Kind == "agent" && pkg.Name != in.SkillRef.Name {
		return LoadedPackage{}, failure("content_changed", "Skill content changed; choose again")
	}
	return LoadedPackage{SkillRef: in.SkillRef, Package: pkg}, nil
}
func promotionFingerprint(in PromoteInput) string {
	data, _ := json.Marshal(in)
	return digest(append([]byte("antnest-skill-promotion-v1\x00"), data...))
}
func (d *Discovery) Promote(ctx context.Context, in PromoteInput) (Version, error) {
	if !validRequestID(in.RequestID) || !organizationID.MatchString(in.OrganizationID) || !userID.MatchString(in.ActorID) || !validRef(in.SkillRef) || in.SkillRef.Kind != "agent" || !contentDigest.MatchString(in.ExpectedDigest) ||
		in.SkillID == "" && in.ExpectedVersion != 0 || in.SkillID != "" && (!skillID.MatchString(in.SkillID) || in.ExpectedVersion < 1) {
		return Version{}, failure("invalid_request", "invalid Skill promotion identity or target")
	}
	fingerprint := promotionFingerprint(in)
	stored, previous, exists, err := d.service.store.Receipt(ctx, in.OrganizationID, in.RequestID)
	if err != nil {
		return Version{}, err
	}
	if exists {
		if stored != fingerprint {
			return Version{}, failure("request_conflict", "request ID was used with different input")
		}
		return previous, nil
	}
	loaded, err := d.Load(ctx, LoadInput{OrganizationID: in.OrganizationID, ActorID: in.ActorID, SkillRef: in.SkillRef, ExpectedDigest: in.ExpectedDigest})
	if err != nil {
		return Version{}, err
	}
	id := in.SkillID
	if id == "" {
		id, err = newSkillID()
		if err != nil {
			return Version{}, err
		}
	}
	return d.service.store.Publish(ctx, PublishRecord{
		PublishInput: PublishInput{RequestID: in.RequestID, OrganizationID: in.OrganizationID, ActorID: in.ActorID, SkillID: in.SkillID, ExpectedVersion: in.ExpectedVersion},
		NewSkillID:   id, Fingerprint: fingerprint, Package: loaded.Package,
		Provenance: &SourceProvenance{OrganizationID: in.OrganizationID, SkillRef: in.SkillRef, ContentDigest: in.ExpectedDigest}})
}
