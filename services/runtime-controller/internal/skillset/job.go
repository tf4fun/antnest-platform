package skillset

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
)

type SetKey struct {
	Scope           string
	OrganizationID  string
	AgentID         string
	SkillSetDigest  string
	LayoutVersion   uint32
	Materialization int64
}

type CleanupJob struct {
	SetID      int64
	Key        SetKey
	VolumeName string
}

func (k SetKey) VolumeName() (string, error) {
	if !validScope(k.Scope) || !organizationPattern.MatchString(k.OrganizationID) || !validControlIdentifier(k.AgentID) ||
		!digestPattern.MatchString(k.SkillSetDigest) || k.LayoutVersion != LayoutVersion || k.Materialization < 1 || k.Materialization > 1_000_000_000 {
		return "", fmt.Errorf("invalid Skill set volume identity")
	}
	hash := sha256.New()
	hash.Write([]byte("antnest-skill-volume-v1\x00"))
	for _, value := range []string{k.Scope, k.OrganizationID, k.AgentID, k.SkillSetDigest} {
		hash.Write([]byte(value))
		hash.Write([]byte{0})
	}
	hash.Write([]byte{byte(k.LayoutVersion)})
	return "antnest-skills-" + hex.EncodeToString(hash.Sum(nil)[:16]) + "-m" + strconv.FormatInt(k.Materialization, 10), nil
}

type PackageCheckpoint struct {
	SkillID       string        `json:"skill_id"`
	Version       int64         `json:"version"`
	ContentDigest string        `json:"content_digest"`
	VerifiedBytes int64         `json:"verified_bytes"`
	Files         []PackageFile `json:"files"`
	Directories   []string      `json:"directories"`
}

type PreparationJob struct {
	SetID       int64
	Key         SetKey
	VolumeName  string
	Skills      []FrozenSkill
	Checkpoints []PackageCheckpoint
}
