package server

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

type skillSourceFile struct {
	Path       string `json:"path"`
	Size       uint64 `json:"size"`
	Executable bool   `json:"executable"`
	digest     [32]byte
}

type skillSourcePreview struct {
	SkillRef      agentSkillSourceRef `json:"skill_ref"`
	ContentDigest string              `json:"content_digest"`
	SkillMD       string              `json:"skill_md"`
	Files         []skillSourceFile   `json:"files"`
}

type skillSourceReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r skillSourceReader) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(data)
}

// Registry owns YAML/package rules. This consumer checks selected byte identity
// and bounds decompression without extracting files or retaining a package copy.
func inspectSourcePackage(ctx context.Context, selection skillSourceSelection, data []byte, artifactDigest, contentDigest string) (skillSourcePreview, error) {
	invalid := fmt.Errorf("invalid selected Skill package")
	result := skillSourcePreview{SkillRef: selection.SkillRef, ContentDigest: selection.ExpectedDigest}
	artifactHash := sha256.Sum256(data)
	if len(data) == 0 || len(data) > maximumSkillUpload || artifactDigest != "sha256:"+hex.EncodeToString(artifactHash[:]) || contentDigest != selection.ExpectedDigest {
		return result, invalid
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(archive.File) == 0 || len(archive.File) > 256 {
		return result, invalid
	}
	seen := make(map[string]bool, len(archive.File))
	var unpacked uint64
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		name := strings.TrimSuffix(entry.Name, "/")
		directory := strings.HasSuffix(entry.Name, "/")
		segments := strings.Split(name, "/")
		if len(name) == 0 || len(name) > 512 || !utf8.ValidString(name) || strings.ContainsAny(name, "\\\x00") || len(segments) > 16 {
			return result, invalid
		}
		for _, segment := range segments {
			if segment == "" || segment == "." || segment == ".." {
				return result, invalid
			}
		}
		if _, exists := seen[name]; exists {
			return result, invalid
		}
		seen[name] = directory
		mode := entry.Mode()
		if entry.NonUTF8 || entry.Flags&1 != 0 || mode&fs.ModeType != 0 && mode&fs.ModeType != fs.ModeDir || directory != mode.IsDir() {
			return result, invalid
		}
		if directory {
			if entry.UncompressedSize64 != 0 {
				return result, invalid
			}
			continue
		}
		maximum := uint64(maximumSkillUpload)
		if name == "SKILL.md" {
			maximum = 16 << 10
		}
		if entry.UncompressedSize64 > maximum || unpacked+entry.UncompressedSize64 > 32<<20 {
			return result, invalid
		}
		stream, err := entry.Open()
		if err != nil {
			return result, invalid
		}
		hash := sha256.New()
		var sink io.Writer = hash
		var text bytes.Buffer
		if name == "SKILL.md" {
			sink = io.MultiWriter(hash, &text)
		}
		size, readErr := io.Copy(sink, io.LimitReader(skillSourceReader{ctx, stream}, int64(maximum)+1))
		closeErr := stream.Close()
		if readErr != nil || closeErr != nil || size < 0 || uint64(size) != entry.UncompressedSize64 || uint64(size) > maximum {
			return result, invalid
		}
		unpacked += uint64(size)
		file := skillSourceFile{Path: name, Size: uint64(size), Executable: mode.Perm()&0111 != 0}
		copy(file.digest[:], hash.Sum(nil))
		result.Files = append(result.Files, file)
		if name == "SKILL.md" {
			if !utf8.Valid(text.Bytes()) || text.Len() == 0 {
				return result, invalid
			}
			result.SkillMD = text.String()
		}
	}
	if result.SkillMD == "" {
		return result, invalid
	}
	for name := range seen {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if directory, exists := seen[parent]; exists && !directory {
				return result, invalid
			}
		}
	}
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	hash := sha256.New()
	_, _ = hash.Write([]byte("antnest-skill-manifest-v1\x00"))
	var size [8]byte
	for _, file := range result.Files {
		binary.BigEndian.PutUint32(size[:4], uint32(len(file.Path)))
		_, _ = hash.Write(size[:4])
		_, _ = hash.Write([]byte(file.Path))
		binary.BigEndian.PutUint64(size[:], file.Size)
		_, _ = hash.Write(size[:])
		_, _ = hash.Write(file.digest[:])
		executable := byte(0)
		if file.Executable {
			executable = 1
		}
		_, _ = hash.Write([]byte{executable})
	}
	if "sha256:"+hex.EncodeToString(hash.Sum(nil)) != selection.ExpectedDigest {
		return result, invalid
	}
	return result, nil
}
