package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	maxLegacyInventoryEntries = 10_000
	maxLegacyInventoryBytes   = 1 << 30
)

var ErrLegacyInventoryChanged = errors.New("legacy system Skill volume changed during inventory")

type LegacyInventoryEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Mode   uint32 `json:"mode"`
	Size   int64  `json:"size"`
	Digest string `json:"digest,omitempty"`
}

type LegacyInventoryReference struct {
	ContainerID string `json:"container_id"`
	AgentID     string `json:"agent_id,omitempty"`
	Running     bool   `json:"running"`
	Managed     bool   `json:"managed"`
}

type LegacySystemSkillsInventory struct {
	VolumeName      string                     `json:"volume_name"`
	InventoryDigest string                     `json:"inventory_digest"`
	Entries         []LegacyInventoryEntry     `json:"entries"`
	References      []LegacyInventoryReference `json:"references"`
}

type LegacyInventoryEngine interface {
	InspectVolume(context.Context, string) (Volume, error)
	ListAllContainers(context.Context) ([]Container, error)
}

type LegacyInventoryReader struct {
	engine     LegacyInventoryEngine
	root       string
	volumeName string
	scope      string
}

func NewLegacyInventoryReader(engine LegacyInventoryEngine, root, volumeName, scope string) (*LegacyInventoryReader, error) {
	if engine == nil || root == "" || volumeName == "" || scope == "" {
		return nil, fmt.Errorf("legacy inventory configuration is incomplete")
	}
	return &LegacyInventoryReader{engine: engine, root: root, volumeName: volumeName, scope: scope}, nil
}

func (reader *LegacyInventoryReader) Inventory(ctx context.Context) (LegacySystemSkillsInventory, error) {
	volume, err := reader.engine.InspectVolume(ctx, reader.volumeName)
	if err != nil || volume.Name != reader.volumeName {
		return LegacySystemSkillsInventory{}, fmt.Errorf("inspect legacy system Skill volume: %v", err)
	}
	containers, err := reader.engine.ListAllContainers(ctx)
	if err != nil {
		return LegacySystemSkillsInventory{}, fmt.Errorf("list legacy Skill volume consumers: %w", err)
	}
	return InventoryLegacySystemSkills(ctx, reader.root, reader.volumeName, reader.scope, containers)
}

// InventoryLegacySystemSkills observes the read-only shared mount twice. It
// never follows links or interprets old files as valid Registry packages.
// Callers must still quiesce writers and compare against a protected backup.
func InventoryLegacySystemSkills(ctx context.Context, root, volumeName, scope string, containers []Container) (LegacySystemSkillsInventory, error) {
	if root == "" || volumeName == "" || scope == "" {
		return LegacySystemSkillsInventory{}, fmt.Errorf("legacy inventory identity is incomplete")
	}
	first, err := scanLegacyEntries(ctx, root)
	if err != nil {
		return LegacySystemSkillsInventory{}, err
	}
	second, err := scanLegacyEntries(ctx, root)
	if err != nil {
		return LegacySystemSkillsInventory{}, err
	}
	if !reflect.DeepEqual(first, second) {
		return LegacySystemSkillsInventory{}, ErrLegacyInventoryChanged
	}
	encoded, err := json.Marshal(first)
	if err != nil {
		return LegacySystemSkillsInventory{}, err
	}
	digest := sha256.Sum256(encoded)
	references := make([]LegacyInventoryReference, 0)
	for _, container := range containers {
		for _, mount := range container.Mounts {
			if mount.Type != "volume" || mount.Name != volumeName {
				continue
			}
			managed := container.Labels[labelManaged] == "runtime" && container.Labels[labelScope] == scope && container.Labels[labelAgentID] != ""
			reference := LegacyInventoryReference{ContainerID: container.ID, Running: container.Running, Managed: managed}
			if managed {
				reference.AgentID = container.Labels[labelAgentID]
			}
			references = append(references, reference)
			break
		}
	}
	slices.SortFunc(references, func(a, b LegacyInventoryReference) int {
		return strings.Compare(a.ContainerID, b.ContainerID)
	})
	return LegacySystemSkillsInventory{
		VolumeName: volumeName, InventoryDigest: "sha256:" + hex.EncodeToString(digest[:]),
		Entries: first, References: references,
	}, nil
}

func scanLegacyEntries(ctx context.Context, root string) ([]LegacyInventoryEntry, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("inspect legacy system Skill mount: %w", err)
	}
	if !rootInfo.IsDir() {
		return nil, fmt.Errorf("legacy system Skill mount is not a directory")
	}
	rootHandle, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("open legacy system Skill mount: %w", err)
	}
	defer func() { _ = rootHandle.Close() }()
	entries := make([]LegacyInventoryEntry, 0)
	var total int64
	err = filepath.WalkDir(root, func(name string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if name == root {
			return nil
		}
		if len(entries) >= maxLegacyInventoryEntries {
			return fmt.Errorf("legacy inventory entry limit exceeded")
		}
		relative, err := filepath.Rel(root, name)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || !utf8.ValidString(relative) {
			return fmt.Errorf("legacy inventory path is invalid")
		}
		info, err := item.Info()
		if err != nil {
			return err
		}
		entry := LegacyInventoryEntry{Path: filepath.ToSlash(relative), Mode: uint32(info.Mode().Perm())}
		switch {
		case info.Mode().IsRegular():
			entry.Kind = "regular"
			entry.Size = info.Size()
			if entry.Size < 0 || entry.Size > maxLegacyInventoryBytes-total {
				return fmt.Errorf("legacy inventory byte limit exceeded")
			}
			file, err := rootHandle.Open(relative)
			if err != nil {
				return err
			}
			opened, err := file.Stat()
			if err != nil || !os.SameFile(info, opened) {
				_ = file.Close()
				return ErrLegacyInventoryChanged
			}
			hasher := sha256.New()
			read, readErr := io.Copy(hasher, &legacyContextReader{ctx: ctx, source: file})
			closeErr := file.Close()
			if err := errors.Join(readErr, closeErr); err != nil {
				return err
			}
			if read != entry.Size {
				return ErrLegacyInventoryChanged
			}
			total += read
			entry.Digest = "sha256:" + hex.EncodeToString(hasher.Sum(nil))
		case info.IsDir():
			entry.Kind = "directory"
		case info.Mode()&os.ModeSymlink != 0:
			entry.Kind = "symlink"
			target, err := os.Readlink(name)
			if err != nil {
				return err
			}
			hash := sha256.Sum256([]byte(target))
			entry.Digest = "sha256:" + hex.EncodeToString(hash[:])
		default:
			entry.Kind = "unsupported"
		}
		entries = append(entries, entry)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("scan legacy system Skills: %w", err)
	}
	slices.SortFunc(entries, func(a, b LegacyInventoryEntry) int {
		return strings.Compare(a.Path, b.Path)
	})
	return entries, nil
}

type legacyContextReader struct {
	ctx    context.Context
	source io.Reader
}

func (reader *legacyContextReader) Read(data []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.source.Read(data)
}
