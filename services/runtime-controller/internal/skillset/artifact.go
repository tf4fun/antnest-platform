package skillset

import (
	"archive/tar"
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
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const (
	maxArtifactBytes = 8 << 20
	maxUnpackedBytes = 32 << 20
	maxSkillBytes    = 16 << 10
	maxZIPEntries    = 256
)

type PackageFile struct {
	Path       string `json:"path"`
	Size       uint64 `json:"size"`
	Digest     string `json:"digest"`
	Executable bool   `json:"executable"`
}

type Package struct {
	Name           string
	Description    string
	ArtifactDigest string
	ContentDigest  string
	UnpackedSize   uint64
	Files          []PackageFile
	Directories    []string
}

type checkedReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r checkedReader) Read(value []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(value)
}

func contentHash(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// InspectArtifact independently checks the Registry package rules and computes
// the immutable file manifest. File bodies are streamed and not retained.
func InspectArtifact(ctx context.Context, artifact []byte) (Package, error) {
	if len(artifact) == 0 || len(artifact) > maxArtifactBytes {
		return Package{}, fmt.Errorf("ZIP artifact exceeds 8 MiB")
	}
	archive, err := zip.NewReader(bytes.NewReader(artifact), int64(len(artifact)))
	if err != nil {
		return Package{}, fmt.Errorf("invalid ZIP archive: %w", err)
	}
	if len(archive.File) == 0 || len(archive.File) > maxZIPEntries {
		return Package{}, fmt.Errorf("ZIP entry count exceeds limit")
	}
	result := Package{ArtifactDigest: contentHash(artifact)}
	seen := make(map[string]bool, len(archive.File))
	var manifest []byte
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return Package{}, err
		}
		isDirectory := strings.HasSuffix(entry.Name, "/")
		name := strings.TrimSuffix(entry.Name, "/")
		_, exists := seen[name]
		if !validArchivePath(name) || exists {
			return Package{}, fmt.Errorf("invalid or duplicate ZIP path")
		}
		seen[name] = true
		mode := entry.Mode()
		if entry.Flags&1 != 0 || entry.NonUTF8 || !safeZIPExtra(entry.Extra) ||
			mode&fs.ModeType != 0 && mode&fs.ModeType != fs.ModeDir || isDirectory != mode.IsDir() {
			return Package{}, fmt.Errorf("ZIP contains encrypted, nonregular or unsafe entry")
		}
		if isDirectory {
			if entry.UncompressedSize64 != 0 {
				return Package{}, fmt.Errorf("ZIP directory contains data")
			}
			result.Directories = append(result.Directories, name)
			continue
		}
		maxSize := uint64(maxArtifactBytes)
		if name == "SKILL.md" {
			maxSize = maxSkillBytes
		}
		if entry.UncompressedSize64 > maxSize || result.UnpackedSize+entry.UncompressedSize64 > maxUnpackedBytes {
			return Package{}, fmt.Errorf("ZIP member exceeds size limit")
		}
		stream, err := entry.Open()
		if err != nil {
			return Package{}, fmt.Errorf("open ZIP member: %w", err)
		}
		hash := sha256.New()
		var body bytes.Buffer
		var sink io.Writer = hash
		if name == "SKILL.md" {
			sink = io.MultiWriter(hash, &body)
		}
		actual, copyErr := io.Copy(sink, io.LimitReader(checkedReader{ctx, stream}, int64(maxSize)+1))
		closeErr := stream.Close()
		if err := ctx.Err(); err != nil {
			return Package{}, err
		}
		if actual > int64(maxSize) || result.UnpackedSize+uint64(actual) > maxUnpackedBytes ||
			copyErr != nil || closeErr != nil || uint64(actual) != entry.UncompressedSize64 {
			return Package{}, fmt.Errorf("ZIP member checksum or size differs")
		}
		result.UnpackedSize += uint64(actual)
		result.Files = append(result.Files, PackageFile{Path: name, Size: uint64(actual), Digest: "sha256:" + hex.EncodeToString(hash.Sum(nil)), Executable: mode.Perm()&0111 != 0})
		if name == "SKILL.md" {
			manifest = bytes.Clone(body.Bytes())
		}
	}
	if manifest == nil {
		return Package{}, fmt.Errorf("root SKILL.md is required")
	}
	for name := range seen {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if directory, exists := seen[parent]; exists && !directory {
				return Package{}, fmt.Errorf("file conflicts with ZIP child path")
			}
		}
	}
	name, description, err := parseSkillManifest(manifest)
	if err != nil {
		return Package{}, err
	}
	result.Name, result.Description = name, description
	slices.SortFunc(result.Files, func(a, b PackageFile) int { return strings.Compare(a.Path, b.Path) })
	slices.Sort(result.Directories)
	result.ContentDigest = packageManifestDigest(result.Files)
	return result, nil
}

func ValidateFrozenArtifact(ctx context.Context, artifact []byte, expected FrozenSkill) (Package, error) {
	pkg, err := InspectArtifact(ctx, artifact)
	if err != nil {
		return Package{}, err
	}
	if expected.PackageRulesVersion != 1 || pkg.Name != expected.Name || pkg.Description != expected.Description ||
		pkg.ArtifactDigest != expected.ArtifactDigest || pkg.ContentDigest != expected.ContentDigest ||
		int64(len(artifact)) != expected.ArtifactSize || int64(pkg.UnpackedSize) != expected.UnpackedSize {
		return Package{}, fmt.Errorf("registry artifact differs from frozen Skill metadata")
	}
	return pkg, nil
}

func safeZIPExtra(value []byte) bool {
	seen := map[uint16]bool{}
	for len(value) > 0 {
		if len(value) < 4 {
			return false
		}
		id := binary.LittleEndian.Uint16(value[:2])
		length := int(binary.LittleEndian.Uint16(value[2:4]))
		value = value[4:]
		if length > len(value) || seen[id] || id != 0x0001 && id != 0x5455 {
			return false
		}
		seen[id] = true
		value = value[length:]
	}
	return true
}

func validArchivePath(value string) bool {
	if value == "" || len(value) > 512 || !utf8.ValidString(value) || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\\x00") {
		return false
	}
	segments := strings.Split(value, "/")
	if len(segments) > 16 {
		return false
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func packageManifestDigest(files []PackageFile) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte("antnest-skill-manifest-v1\x00"))
	var raw [8]byte
	for _, file := range files {
		binary.BigEndian.PutUint32(raw[:4], uint32(len(file.Path)))
		_, _ = hash.Write(raw[:4])
		_, _ = hash.Write([]byte(file.Path))
		binary.BigEndian.PutUint64(raw[:], file.Size)
		_, _ = hash.Write(raw[:])
		binaryDigest, _ := hex.DecodeString(strings.TrimPrefix(file.Digest, "sha256:"))
		_, _ = hash.Write(binaryDigest)
		if file.Executable {
			_, _ = hash.Write([]byte{1})
		} else {
			_, _ = hash.Write([]byte{0})
		}
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil))
}

func WriteNormalizedTar(ctx context.Context, artifact []byte, expected Package, output io.Writer) error {
	verified, err := InspectArtifact(ctx, artifact)
	if err != nil {
		return err
	}
	if verified.Name != expected.Name || verified.ArtifactDigest != expected.ArtifactDigest || verified.ContentDigest != expected.ContentDigest {
		return fmt.Errorf("artifact changed since verification")
	}
	archive, err := zip.NewReader(bytes.NewReader(artifact), int64(len(artifact)))
	if err != nil {
		return err
	}
	entries := make(map[string]*zip.File, len(archive.File))
	directories := map[string]bool{verified.Name: true}
	for _, entry := range archive.File {
		name := strings.TrimSuffix(entry.Name, "/")
		if strings.HasSuffix(entry.Name, "/") {
			directories[verified.Name+"/"+name] = true
		} else {
			entries[name] = entry
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			directories[verified.Name+"/"+parent] = true
		}
	}
	ordered := make([]string, 0, len(directories))
	for name := range directories {
		ordered = append(ordered, name)
	}
	slices.SortFunc(ordered, func(a, b string) int {
		depthA, depthB := strings.Count(a, "/"), strings.Count(b, "/")
		if depthA != depthB {
			return depthA - depthB
		}
		return strings.Compare(a, b)
	})
	writer := tar.NewWriter(output)
	for _, name := range ordered {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := writer.WriteHeader(&tar.Header{Name: name + "/", Mode: 0555, Typeflag: tar.TypeDir, Uid: 0, Gid: 0}); err != nil {
			return err
		}
	}
	for _, file := range verified.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		mode := int64(0444)
		if file.Executable {
			mode = 0555
		}
		if err := writer.WriteHeader(&tar.Header{Name: verified.Name + "/" + file.Path, Mode: mode, Size: int64(file.Size), Typeflag: tar.TypeReg, Uid: 0, Gid: 0}); err != nil {
			return err
		}
		entry := entries[file.Path]
		stream, err := entry.Open()
		if err != nil {
			return err
		}
		hash := sha256.New()
		actual, copyErr := io.CopyN(io.MultiWriter(writer, hash), checkedReader{ctx, stream}, int64(file.Size))
		closeErr := stream.Close()
		if err := ctx.Err(); err != nil {
			return err
		}
		if copyErr != nil || closeErr != nil || uint64(actual) != file.Size || "sha256:"+hex.EncodeToString(hash.Sum(nil)) != file.Digest {
			return fmt.Errorf("artifact changed during normalized tar creation")
		}
	}
	return writer.Close()
}

var frontmatterDate = regexp.MustCompile(`^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}($|[Tt ])`)
var underscoreNumber = regexp.MustCompile(`^[+-]?[0-9][0-9A-Fa-f_xXoObBeE.+-]*$`)

func parseSkillManifest(data []byte) (string, string, error) {
	if !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return "", "", fmt.Errorf("SKILL.md must be UTF-8 without BOM")
	}
	lines := strings.Split(string(data), "\n")
	line := func(value string) string { return strings.TrimSuffix(value, "\r") }
	if len(lines) < 3 || line(lines[0]) != "---" {
		return "", "", fmt.Errorf("SKILL.md must begin with exact frontmatter delimiter")
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if line(lines[i]) == "---" {
			end = i
			break
		}
		if line(lines[i]) == "..." {
			return "", "", fmt.Errorf("YAML document end marker is forbidden")
		}
	}
	if end < 0 {
		return "", "", fmt.Errorf("SKILL.md frontmatter has no exact closing delimiter")
	}
	header := make([]string, 0, end-1)
	for _, value := range lines[1:end] {
		header = append(header, line(value))
	}
	decoder := yaml.NewDecoder(strings.NewReader(strings.Join(header, "\n")))
	var document yaml.Node
	if err := decoder.Decode(&document); err != nil || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return "", "", fmt.Errorf("skill frontmatter must be one mapping")
	}
	var second yaml.Node
	if err := decoder.Decode(&second); err != io.EOF {
		return "", "", fmt.Errorf("multiple YAML documents are forbidden")
	}
	count := 0
	if err := checkYAMLNode(&document, 0, &count); err != nil {
		return "", "", err
	}
	fields := document.Content[0].Content
	var name, description string
	for i := 0; i < len(fields); i += 2 {
		var err error
		switch fields[i].Value {
		case "name":
			name, err = yamlStringField(fields[i+1])
		case "description":
			description, err = yamlStringField(fields[i+1])
		}
		if err != nil {
			return "", "", err
		}
	}
	if len(name) == 0 || len(name) > 64 || !namePattern.MatchString(name) {
		return "", "", fmt.Errorf("invalid Skill name")
	}
	description = strings.TrimSpace(description)
	if description == "" || len(description) > 512 || strings.ContainsRune(description, 0) {
		return "", "", fmt.Errorf("invalid Skill description")
	}
	return name, description, nil
}

func checkYAMLNode(node *yaml.Node, depth int, count *int) error {
	*count++
	if depth > 16 || *count > 512 {
		return fmt.Errorf("YAML nesting or node count exceeds limit")
	}
	if node.Anchor != "" || node.Kind == yaml.AliasNode || node.Style&yaml.TaggedStyle != 0 {
		return fmt.Errorf("YAML aliases or explicit tags forbidden")
	}
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || key.Value == "<<" || seen[key.Value] {
				return fmt.Errorf("YAML merge or duplicate/nonstring key forbidden")
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if err := checkYAMLNode(child, depth+1, count); err != nil {
			return err
		}
	}
	return nil
}

func yamlStringField(node *yaml.Node) (string, error) {
	if node.Kind != yaml.ScalarNode || node.Tag != "!!str" {
		return "", fmt.Errorf("skill name and description must be YAML strings")
	}
	if node.Style&(yaml.SingleQuotedStyle|yaml.DoubleQuotedStyle|yaml.LiteralStyle|yaml.FoldedStyle) == 0 && rejectPlainYAML(node.Value) {
		return "", fmt.Errorf("plain YAML value is not a portable string")
	}
	return node.Value, nil
}

func rejectPlainYAML(value string) bool {
	lower := strings.ToLower(value)
	if frontmatterDate.MatchString(value) || lower == "true" || lower == "false" || lower == "null" || value == "~" || value == "" {
		return true
	}
	if strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") {
		if len(value) > 1 && (value[1] == '+' || value[1] == '-' || value[1] >= '0' && value[1] <= '9') {
			return true
		}
		value = value[1:]
	}
	lower = strings.ToLower(value)
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "0o") || strings.HasPrefix(lower, "0b") {
		return true
	}
	return strings.Contains(value, "_") && underscoreNumber.MatchString(value)
}
