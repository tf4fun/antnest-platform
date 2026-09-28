package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
)

const SkillLayoutVersion uint32 = 1

// SkillSetDigest is the platform's v1 content identity for one organization's
// complete, fixed, sorted system-Skill set. Runtime Controller must recompute it.
func SkillSetDigest(organizationID string, skills []FrozenSkill) (string, error) {
	if strings.TrimSpace(organizationID) == "" || len(organizationID) > 200 {
		return "", fmt.Errorf("skill collection organization is invalid")
	}
	if err := ValidateFrozenSkills(skills); err != nil {
		return "", err
	}
	ordered := slices.Clone(skills)
	slices.SortFunc(ordered, func(a, b FrozenSkill) int { return strings.Compare(a.SkillID, b.SkillID) })
	var payload bytes.Buffer
	payload.WriteString("antnest-skill-set-v1\x00")
	appendUint32(&payload, SkillLayoutVersion)
	appendString(&payload, organizationID)
	appendUint32(&payload, uint32(len(ordered)))
	for _, skill := range ordered {
		appendString(&payload, skill.SkillID)
		appendUint64(&payload, uint64(skill.Version))
		appendString(&payload, skill.Name)
		appendString(&payload, skill.Description)
		appendString(&payload, skill.ArtifactDigest)
		appendString(&payload, skill.ContentDigest)
		appendUint64(&payload, uint64(skill.ArtifactSize))
		appendUint64(&payload, uint64(skill.UnpackedSize))
		appendUint32(&payload, uint32(skill.PackageRulesVersion))
	}
	digest := sha256.Sum256(payload.Bytes())
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func appendString(payload *bytes.Buffer, value string) {
	appendUint32(payload, uint32(len(value)))
	payload.WriteString(value)
}

func appendUint32(payload *bytes.Buffer, value uint32) {
	var bytes [4]byte
	binary.BigEndian.PutUint32(bytes[:], value)
	payload.Write(bytes[:])
}

func appendUint64(payload *bytes.Buffer, value uint64) {
	var bytes [8]byte
	binary.BigEndian.PutUint64(bytes[:], value)
	payload.Write(bytes[:])
}
