package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"

	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

// The old tar regular-file type is NUL. Keep accepting it when reading
// archives without depending on the deprecated standard-library identifier.
const oldTarRegularType byte = 0

type skillCollectionInventory struct {
	LayoutVersion  uint32 `json:"layout_version"`
	OrganizationID string `json:"organization_id"`
	AgentID        string `json:"agent_id"`
	SkillSetDigest string `json:"skill_set_digest"`
	Skills         []struct {
		SkillID        string                 `json:"skill_id"`
		Version        int64                  `json:"version"`
		Name           string                 `json:"name"`
		ArtifactDigest string                 `json:"artifact_digest"`
		ContentDigest  string                 `json:"content_digest"`
		SkillMDDigest  string                 `json:"skill_md_digest"`
		Files          []skillset.PackageFile `json:"files"`
		Directories    []string               `json:"directories"`
	} `json:"skills"`
}

func (w *SkillVolumeWriter) verifyCollection(ctx context.Context, containerID string, key skillset.SetKey, manifest []byte) (resultErr error) {
	stream, err := w.engine.GetArchive(ctx, containerID, "/skills")
	if err != nil {
		return fmt.Errorf("read back Skill collection: %w", err)
	}
	defer func() { resultErr = errorsJoinClose(resultErr, stream.Close()) }()
	return verifyCollectionArchive(ctx, stream, key, manifest)
}

func errorsJoinClose(result error, closeErr error) error {
	if closeErr == nil {
		return result
	}
	if result == nil {
		return closeErr
	}
	return fmt.Errorf("%w; close archive: %v", result, closeErr)
}

func verifyCollectionArchive(ctx context.Context, source io.Reader, key skillset.SetKey, manifest []byte) error {
	if len(manifest) == 0 || len(manifest) > 8<<20 {
		return fmt.Errorf("skill collection manifest size is invalid")
	}
	var inventory skillCollectionInventory
	decoder := json.NewDecoder(bytes.NewReader(manifest))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&inventory); err != nil {
		return fmt.Errorf("decode Skill collection manifest: %w", err)
	}
	if inventory.LayoutVersion != key.LayoutVersion || inventory.OrganizationID != key.OrganizationID || inventory.AgentID != key.AgentID || inventory.SkillSetDigest != key.SkillSetDigest || len(inventory.Skills) > 32 {
		return fmt.Errorf("skill collection manifest identity differs")
	}
	expectedFiles := map[string]skillset.PackageFile{}
	expectedDirs := map[string]bool{}
	for _, skill := range inventory.Skills {
		if skill.Name == "" || strings.Contains(skill.Name, "/") || skill.Name == "." || skill.Name == ".." {
			return fmt.Errorf("skill collection name is unsafe")
		}
		root := "skills/" + skill.Name
		if expectedDirs[root] {
			return fmt.Errorf("skill collection contains duplicate name")
		}
		expectedDirs[root] = true
		for _, directory := range skill.Directories {
			if !safeSkillRelativePath(directory) {
				return fmt.Errorf("skill collection directory path is unsafe")
			}
			for current := directory; current != "."; current = path.Dir(current) {
				expectedDirs[root+"/"+current] = true
			}
		}
		for _, file := range skill.Files {
			if !safeSkillRelativePath(file.Path) || file.Size > 8<<20 || len(file.Digest) != 71 || !strings.HasPrefix(file.Digest, "sha256:") {
				return fmt.Errorf("skill collection file inventory is invalid")
			}
			name := root + "/" + file.Path
			if _, exists := expectedFiles[name]; exists {
				return fmt.Errorf("skill collection has duplicate file")
			}
			expectedFiles[name] = file
			for current := path.Dir(file.Path); current != "."; current = path.Dir(current) {
				expectedDirs[root+"/"+current] = true
			}
		}
	}
	seenDirs := map[string]bool{}
	seenFiles := map[string]bool{}
	reader := tar.NewReader(source)
	var total uint64
	for entries := 0; ; entries++ {
		if entries > 9000 {
			return fmt.Errorf("skill collection archive has too many entries")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(strings.TrimPrefix(header.Name, "./"), "/")
		if name == "skills" {
			if entries != 0 || header.Typeflag != tar.TypeDir {
				return fmt.Errorf("skill collection root differs")
			}
			continue
		}
		if !strings.HasPrefix(name, "skills/") || path.Clean(name) != name || header.Uid != 0 || header.Gid != 0 {
			return fmt.Errorf("skill collection archive identity differs")
		}
		if header.Typeflag == tar.TypeDir {
			if !expectedDirs[name] || seenDirs[name] || header.Mode&07777 != 0555 {
				return fmt.Errorf("skill collection directory differs: %s", name)
			}
			seenDirs[name] = true
			continue
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != oldTarRegularType {
			return fmt.Errorf("skill collection has nonregular entry")
		}
		if name == "skills/.antnest-skills.json" {
			if seenFiles[name] || header.Mode&07777 != 0444 || header.Size != int64(len(manifest)) {
				return fmt.Errorf("skill collection manifest differs")
			}
			actual := make([]byte, len(manifest))
			if _, err := io.ReadFull(reader, actual); err != nil || !bytes.Equal(actual, manifest) {
				return fmt.Errorf("skill collection manifest bytes differ: %v", err)
			}
			seenFiles[name] = true
			continue
		}
		file, ok := expectedFiles[name]
		mode := int64(0444)
		if file.Executable {
			mode = 0555
		}
		if !ok || seenFiles[name] || header.Mode&07777 != mode || header.Size != int64(file.Size) {
			return fmt.Errorf("skill collection file identity differs: %s", name)
		}
		total += file.Size
		if total > 128<<20 {
			return fmt.Errorf("skill collection exceeds 128 MiB")
		}
		hash := sha256.New()
		if _, err := io.CopyN(hash, reader, int64(file.Size)); err != nil || "sha256:"+hex.EncodeToString(hash.Sum(nil)) != file.Digest {
			return fmt.Errorf("skill collection file bytes differ: %s: %v", name, err)
		}
		seenFiles[name] = true
	}
	if len(seenDirs) != len(expectedDirs) || len(seenFiles) != len(expectedFiles)+1 {
		return fmt.Errorf("skill collection contains missing entries")
	}
	return nil
}

func safeSkillRelativePath(value string) bool {
	return value != "" && value != "." && !strings.HasPrefix(value, "/") && !strings.Contains(value, "\\") && path.Clean(value) == value && value != ".." && !strings.HasPrefix(value, "../")
}
