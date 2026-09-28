// Package skillset owns Runtime Controller's independent validation of a
// frozen, organization-scoped system-Skill collection.
package skillset

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

const LayoutVersion uint32 = 1

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

var idPattern = regexp.MustCompile(`^skill_[0-9a-f]{32}$`)
var namePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var organizationPattern = regexp.MustCompile(`^org_[0-9a-f]{32}$`)

func Validate(organizationID string, layoutVersion uint32, skills []FrozenSkill) error {
	if !organizationPattern.MatchString(organizationID) {
		return fmt.Errorf("invalid organization_id")
	}
	if layoutVersion != LayoutVersion {
		return fmt.Errorf("unsupported Skill layout_version")
	}
	if len(skills) > 32 {
		return fmt.Errorf("too many system Skills")
	}
	ids, names := make(map[string]bool, len(skills)), make(map[string]bool, len(skills))
	var total int64
	for _, skill := range skills {
		if !idPattern.MatchString(skill.SkillID) || skill.Version <= 0 ||
			len(skill.Name) == 0 || len(skill.Name) > 64 || !namePattern.MatchString(skill.Name) ||
			strings.TrimSpace(skill.Description) == "" || len(skill.Description) > 512 || strings.ContainsRune(skill.Description, 0) ||
			!digestPattern.MatchString(skill.ArtifactDigest) || !digestPattern.MatchString(skill.ContentDigest) ||
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
		return fmt.Errorf("system Skill set exceeds 128 MiB")
	}
	return nil
}

// Digest implements the v1 byte encoding frozen by the Controller contract.
// It deliberately does not import Controller code: both owners verify the same
// language-neutral fixture.
func Digest(organizationID string, layoutVersion uint32, skills []FrozenSkill) (string, error) {
	if err := Validate(organizationID, layoutVersion, skills); err != nil {
		return "", err
	}
	ordered := slices.Clone(skills)
	slices.SortFunc(ordered, func(a, b FrozenSkill) int { return strings.Compare(a.SkillID, b.SkillID) })
	var payload bytes.Buffer
	payload.WriteString("antnest-skill-set-v1\x00")
	writeUint32(&payload, layoutVersion)
	writeString(&payload, organizationID)
	writeUint32(&payload, uint32(len(ordered)))
	for _, skill := range ordered {
		writeString(&payload, skill.SkillID)
		writeUint64(&payload, uint64(skill.Version))
		writeString(&payload, skill.Name)
		writeString(&payload, skill.Description)
		writeString(&payload, skill.ArtifactDigest)
		writeString(&payload, skill.ContentDigest)
		writeUint64(&payload, uint64(skill.ArtifactSize))
		writeUint64(&payload, uint64(skill.UnpackedSize))
		writeUint32(&payload, uint32(skill.PackageRulesVersion))
	}
	hash := sha256.Sum256(payload.Bytes())
	return "sha256:" + hex.EncodeToString(hash[:]), nil
}

func writeString(to *bytes.Buffer, value string) {
	writeUint32(to, uint32(len(value)))
	to.WriteString(value)
}
func writeUint32(to *bytes.Buffer, value uint32) {
	var raw [4]byte
	binary.BigEndian.PutUint32(raw[:], value)
	to.Write(raw[:])
}
func writeUint64(to *bytes.Buffer, value uint64) {
	var raw [8]byte
	binary.BigEndian.PutUint64(raw[:], value)
	to.Write(raw[:])
}
