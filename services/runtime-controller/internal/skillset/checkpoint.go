package skillset

import (
	"fmt"
	"path"
	"slices"
	"strings"
)

// PackageFromCheckpoint reconstructs only a previously verified immutable
// package. The digest and size are recalculated from the saved file inventory.
func PackageFromCheckpoint(skill FrozenSkill, checkpoint PackageCheckpoint) (Package, error) {
	if checkpoint.SkillID != skill.SkillID || checkpoint.Version != skill.Version ||
		checkpoint.ContentDigest != skill.ContentDigest || checkpoint.VerifiedBytes != skill.UnpackedSize ||
		len(checkpoint.Files) == 0 || len(checkpoint.Files) > 256 {
		return Package{}, fmt.Errorf("skill checkpoint identity differs")
	}
	files := slices.Clone(checkpoint.Files)
	slices.SortFunc(files, func(a, b PackageFile) int { return strings.Compare(a.Path, b.Path) })
	var size uint64
	seen := map[string]bool{}
	for _, file := range files {
		if !validArchivePath(file.Path) || seen[file.Path] || !digestPattern.MatchString(file.Digest) {
			return Package{}, fmt.Errorf("skill checkpoint file inventory is invalid")
		}
		seen[file.Path] = true
		size += file.Size
		if size > 32<<20 {
			return Package{}, fmt.Errorf("skill checkpoint exceeds package size")
		}
	}
	if !seen["SKILL.md"] || int64(size) != skill.UnpackedSize || packageManifestDigest(files) != skill.ContentDigest {
		return Package{}, fmt.Errorf("skill checkpoint content differs")
	}
	for _, directory := range checkpoint.Directories {
		if !validArchivePath(directory) || seen[directory] || path.Base(directory) == "SKILL.md" {
			return Package{}, fmt.Errorf("skill checkpoint directory inventory is invalid")
		}
	}
	return Package{Name: skill.Name, Description: skill.Description, ArtifactDigest: skill.ArtifactDigest,
		ContentDigest: skill.ContentDigest, UnpackedSize: size, Files: files, Directories: slices.Clone(checkpoint.Directories)}, nil
}
