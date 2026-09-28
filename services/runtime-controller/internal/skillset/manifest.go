package skillset

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

type manifestSkill struct {
	SkillID        string        `json:"skill_id"`
	Version        int64         `json:"version"`
	Name           string        `json:"name"`
	ArtifactDigest string        `json:"artifact_digest"`
	ContentDigest  string        `json:"content_digest"`
	SkillMDDigest  string        `json:"skill_md_digest"`
	Files          []PackageFile `json:"files"`
	Directories    []string      `json:"directories"`
}

type collectionManifest struct {
	LayoutVersion  uint32          `json:"layout_version"`
	OrganizationID string          `json:"organization_id"`
	AgentID        string          `json:"agent_id"`
	SkillSetDigest string          `json:"skill_set_digest"`
	Skills         []manifestSkill `json:"skills"`
}

// CollectionManifest is written as a regular file at /skills/.antnest-skills.json.
// Its digest is persisted only after full Docker readback of every package.
func CollectionManifest(job PreparationJob) ([]byte, string, error) {
	if _, err := job.Key.VolumeName(); err != nil {
		return nil, "", err
	}
	computed, err := Digest(job.Key.OrganizationID, job.Key.LayoutVersion, job.Skills)
	if err != nil {
		return nil, "", err
	}
	if computed != job.Key.SkillSetDigest {
		return nil, "", fmt.Errorf("skill collection digest differs from frozen set")
	}
	if len(job.Skills) != len(job.Checkpoints) {
		return nil, "", fmt.Errorf("skill collection has incomplete package checkpoints")
	}
	byID := make(map[string]PackageCheckpoint, len(job.Checkpoints))
	for _, checkpoint := range job.Checkpoints {
		if _, exists := byID[checkpoint.SkillID]; exists {
			return nil, "", fmt.Errorf("duplicate Skill package checkpoint")
		}
		byID[checkpoint.SkillID] = checkpoint
	}
	ordered := slices.Clone(job.Skills)
	slices.SortFunc(ordered, func(a, b FrozenSkill) int { return strings.Compare(a.SkillID, b.SkillID) })
	manifest := collectionManifest{LayoutVersion: job.Key.LayoutVersion, OrganizationID: job.Key.OrganizationID,
		AgentID: job.Key.AgentID, SkillSetDigest: job.Key.SkillSetDigest, Skills: make([]manifestSkill, 0, len(ordered))}
	for _, skill := range ordered {
		checkpoint, ok := byID[skill.SkillID]
		if !ok {
			return nil, "", fmt.Errorf("skill checkpoint is missing")
		}
		pkg, err := PackageFromCheckpoint(skill, checkpoint)
		if err != nil {
			return nil, "", err
		}
		files := pkg.Files
		var skillDigest string
		for _, file := range files {
			if file.Path == "SKILL.md" {
				skillDigest = file.Digest
				break
			}
		}
		if skillDigest == "" {
			return nil, "", fmt.Errorf("skill checkpoint has no SKILL.md")
		}
		manifest.Skills = append(manifest.Skills, manifestSkill{SkillID: skill.SkillID, Version: skill.Version, Name: skill.Name,
			ArtifactDigest: skill.ArtifactDigest, ContentDigest: skill.ContentDigest, SkillMDDigest: skillDigest, Files: files, Directories: slices.Clone(checkpoint.Directories)})
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return nil, "", err
	}
	if len(encoded) > 8<<20 {
		return nil, "", fmt.Errorf("skill collection manifest exceeds 8 MiB")
	}
	hash := sha256.Sum256(encoded)
	return encoded, "sha256:" + hex.EncodeToString(hash[:]), nil
}
