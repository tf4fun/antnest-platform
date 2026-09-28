package registry

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
)

const MaxResolvedBytes = 128 << 20

var (
	organizationID = regexp.MustCompile(`^org_[0-9a-f]{32}$`)
	userID         = regexp.MustCompile(`^user_[0-9a-f]{32}$`)
	skillID        = regexp.MustCompile(`^skill_[0-9a-f]{32}$`)
)

type PublishInput struct {
	RequestID       string
	OrganizationID  string
	ActorID         string
	SkillID         string
	ExpectedVersion int64
	Artifact        []byte
}

type PublishRecord struct {
	PublishInput
	NewSkillID  string
	Fingerprint string
	Package     Package
}

type Version struct {
	SkillID             string `json:"skill_id"`
	Version             int64  `json:"version"`
	Name                string `json:"name"`
	Description         string `json:"description"`
	ArtifactDigest      string `json:"artifact_digest"`
	ContentDigest       string `json:"content_digest"`
	ArtifactSize        int    `json:"artifact_size"`
	UnpackedSize        uint64 `json:"unpacked_size"`
	PackageRulesVersion int    `json:"package_rules_version"`
}

type Skill struct {
	SkillID             string `json:"skill_id"`
	Name                string `json:"name"`
	CurrentVersion      int64  `json:"current_version"`
	Description         string `json:"description"`
	ArtifactDigest      string `json:"artifact_digest"`
	ContentDigest       string `json:"content_digest"`
	ArtifactSize        int    `json:"artifact_size"`
	UnpackedSize        uint64 `json:"unpacked_size"`
	PackageRulesVersion int    `json:"package_rules_version"`
}

type Reference struct {
	SkillID string `json:"skill_id"`
	Version int64  `json:"version"`
}

type SkillPage struct {
	Items       []Skill `json:"items"`
	NextAfterID string  `json:"next_after_id"`
}

type VersionPage struct {
	Items            []Version `json:"items"`
	NextAfterVersion int64     `json:"next_after_version"`
}

type Store interface {
	Receipt(context.Context, string, string) (string, Version, bool, error)
	Publish(context.Context, PublishRecord) (Version, error)
	GetVersion(context.Context, string, string, int64) (Version, error)
	List(context.Context, string, string, int) ([]Skill, error)
	Versions(context.Context, string, string, int64, int) ([]Version, error)
	Artifact(context.Context, string, string, int64) (Version, []byte, error)
}

type Service struct{ store Store }

func NewService(store Store) *Service { return &Service{store: store} }

func validRequestID(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for i := range len(value) {
		if value[i] < 33 || value[i] > 126 {
			return false
		}
	}
	return true
}

func newSkillID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "skill_" + hex.EncodeToString(raw[:]), nil
}

func fingerprint(input PublishInput, artifactDigest string) string {
	action := "create"
	if input.SkillID != "" {
		action = "append"
	}
	encoded, _ := json.Marshal(struct {
		Action, OrganizationID, ActorID, SkillID, ArtifactDigest string
		ExpectedVersion                                          int64
	}{action, input.OrganizationID, input.ActorID, input.SkillID, artifactDigest, input.ExpectedVersion})
	sum := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (s *Service) Publish(ctx context.Context, input PublishInput) (Version, error) {
	if !validRequestID(input.RequestID) || !organizationID.MatchString(input.OrganizationID) || !userID.MatchString(input.ActorID) {
		return Version{}, failure("invalid_request", "invalid publication identity")
	}
	if input.SkillID == "" && input.ExpectedVersion != 0 || input.SkillID != "" && (!skillID.MatchString(input.SkillID) || input.ExpectedVersion < 1) {
		return Version{}, failure("invalid_request", "invalid Skill/version target")
	}
	if len(input.Artifact) == 0 || len(input.Artifact) > MaxArtifactBytes {
		return Version{}, failure("limit_exceeded", "ZIP size must be 1–8 MiB")
	}
	fingerprint := fingerprint(input, digest(input.Artifact))
	stored, previous, exists, err := s.store.Receipt(ctx, input.OrganizationID, input.RequestID)
	if err != nil {
		return Version{}, err
	}
	if exists {
		if stored != fingerprint {
			return Version{}, failure("request_conflict", "request ID was used with different input")
		}
		return previous, nil
	}
	pkg, err := ValidatePackage(ctx, input.Artifact)
	if err != nil {
		return Version{}, err
	}
	newID := input.SkillID
	if newID == "" {
		newID, err = newSkillID()
		if err != nil {
			return Version{}, fmt.Errorf("generate Skill ID: %w", err)
		}
	}
	return s.store.Publish(ctx, PublishRecord{PublishInput: input, NewSkillID: newID,
		Fingerprint: fingerprint, Package: pkg})
}

func pageLimit(limit int) (int, error) {
	if limit == 0 {
		return 50, nil
	}
	if limit < 0 || limit > 100 {
		return 0, failure("invalid_request", "limit must be 1–100")
	}
	return limit, nil
}

func (s *Service) List(ctx context.Context, org, after string, limit int) (SkillPage, error) {
	if !organizationID.MatchString(org) || after != "" && !skillID.MatchString(after) {
		return SkillPage{}, failure("invalid_request", "invalid organization or cursor")
	}
	limit, err := pageLimit(limit)
	if err != nil {
		return SkillPage{}, err
	}
	items, err := s.store.List(ctx, org, after, limit+1)
	if err != nil {
		return SkillPage{}, err
	}
	page := SkillPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextAfterID = page.Items[limit-1].SkillID
	}
	return page, nil
}

func (s *Service) Versions(ctx context.Context, org, id string, after int64, limit int) (VersionPage, error) {
	if !organizationID.MatchString(org) || !skillID.MatchString(id) || after < 0 {
		return VersionPage{}, failure("invalid_request", "invalid organization, Skill or cursor")
	}
	limit, err := pageLimit(limit)
	if err != nil {
		return VersionPage{}, err
	}
	items, err := s.store.Versions(ctx, org, id, after, limit+1)
	if err != nil {
		return VersionPage{}, err
	}
	page := VersionPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextAfterVersion = page.Items[limit-1].Version
	}
	return page, nil
}

func (s *Service) Resolve(ctx context.Context, org string, refs []Reference) ([]Version, error) {
	if !organizationID.MatchString(org) || len(refs) > 32 {
		return nil, failure("invalid_request", "invalid organization or reference count")
	}
	items := make([]Version, 0, len(refs))
	seenSkill, seenName := map[string]bool{}, map[string]bool{}
	var total uint64
	for _, ref := range refs {
		if !skillID.MatchString(ref.SkillID) || ref.Version < 1 || seenSkill[ref.SkillID] {
			return nil, failure("invalid_request", "invalid or repeated Skill reference")
		}
		seenSkill[ref.SkillID] = true
		item, err := s.store.GetVersion(ctx, org, ref.SkillID, ref.Version)
		if err != nil {
			return nil, err
		}
		if seenName[item.Name] || total+item.UnpackedSize > MaxResolvedBytes {
			return nil, failure("limit_exceeded", "resolved Skill set has duplicate names or exceeds 128 MiB")
		}
		seenName[item.Name] = true
		total += item.UnpackedSize
		items = append(items, item)
	}
	return items, nil
}

func (s *Service) Artifact(ctx context.Context, org, id string, version int64) (Version, []byte, error) {
	if !organizationID.MatchString(org) || !skillID.MatchString(id) || version < 1 {
		return Version{}, nil, failure("invalid_request", "invalid artifact identity")
	}
	return s.store.Artifact(ctx, org, id, version)
}
