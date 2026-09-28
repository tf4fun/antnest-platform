package registry

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const (
	PackageRulesVersion = 1
	MaxArtifactBytes    = 8 << 20
	MaxUnpackedBytes    = 32 << 20
	MaxSkillBytes       = 16 << 10
	MaxFiles            = 256
)

var (
	namePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	datePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}($|[Tt ])`)
	underNumber = regexp.MustCompile(`^[+-]?[0-9][0-9A-Fa-f_xXoObBeE.+-]*$`)
)

type File struct {
	Path       string `json:"path"`
	Size       uint64 `json:"size"`
	Digest     string `json:"digest"`
	Executable bool   `json:"executable"`
}

type Package struct {
	Name           string
	Description    string
	Artifact       []byte
	ArtifactDigest string
	ContentDigest  string
	UnpackedSize   uint64
	Files          []File
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (c contextReader) Read(value []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.reader.Read(value)
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func ValidatePackage(ctx context.Context, artifact []byte) (Package, error) {
	if len(artifact) == 0 || len(artifact) > MaxArtifactBytes {
		return Package{}, failure("limit_exceeded", "ZIP size must be 1–8 MiB")
	}
	archive, err := zip.NewReader(bytes.NewReader(artifact), int64(len(artifact)))
	if err != nil {
		return Package{}, failure("invalid_package", "invalid ZIP archive")
	}
	if len(archive.File) == 0 || len(archive.File) > MaxFiles {
		return Package{}, failure("limit_exceeded", "ZIP entry count exceeds 256")
	}
	result := Package{Artifact: artifact, ArtifactDigest: digest(artifact)}
	seen := make(map[string]bool, len(archive.File)) // true means directory
	var manifest []byte
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return Package{}, err
		}
		isDirectory := strings.HasSuffix(entry.Name, "/")
		name := strings.TrimSuffix(entry.Name, "/")
		if !validArchivePath(name) {
			return Package{}, failure("invalid_package", "invalid ZIP entry path")
		}
		if _, exists := seen[name]; exists {
			return Package{}, failure("invalid_package", "duplicate ZIP path")
		}
		seen[name] = isDirectory
		mode := entry.Mode()
		if entry.Flags&1 != 0 || entry.NonUTF8 || !safeZIPExtra(entry.Extra) ||
			mode&fs.ModeType != 0 && mode&fs.ModeType != fs.ModeDir || isDirectory != mode.IsDir() {
			return Package{}, failure("invalid_package", "ZIP contains an encrypted or nonregular entry")
		}
		if isDirectory {
			if entry.UncompressedSize64 != 0 {
				return Package{}, failure("invalid_package", "directory contains data")
			}
			continue
		}
		maxSize := uint64(MaxArtifactBytes)
		if name == "SKILL.md" {
			maxSize = MaxSkillBytes
		}
		if entry.UncompressedSize64 > maxSize || result.UnpackedSize+entry.UncompressedSize64 > MaxUnpackedBytes {
			return Package{}, failure("limit_exceeded", "unpacked ZIP size exceeds limit")
		}
		stream, err := entry.Open()
		if err != nil {
			return Package{}, failure("invalid_package", "cannot open ZIP entry")
		}
		fileHash := sha256.New()
		var sink io.Writer = fileHash
		var body bytes.Buffer
		if name == "SKILL.md" {
			sink = io.MultiWriter(fileHash, &body)
		}
		actual, copyErr := io.Copy(sink, io.LimitReader(contextReader{ctx: ctx, reader: stream}, int64(maxSize)+1))
		closeErr := stream.Close()
		if err := ctx.Err(); err != nil {
			return Package{}, err
		}
		if actual > int64(maxSize) || result.UnpackedSize+uint64(actual) > MaxUnpackedBytes {
			return Package{}, failure("limit_exceeded", "unpacked ZIP size exceeds limit")
		}
		if copyErr != nil || closeErr != nil || uint64(actual) != entry.UncompressedSize64 {
			return Package{}, failure("invalid_package", "ZIP entry checksum or size differs")
		}
		result.UnpackedSize += uint64(actual)
		result.Files = append(result.Files, File{
			Path: name, Size: uint64(actual), Digest: "sha256:" + hex.EncodeToString(fileHash.Sum(nil)),
			Executable: mode.Perm()&0111 != 0,
		})
		if name == "SKILL.md" {
			manifest = body.Bytes()
		}
	}
	if manifest == nil {
		return Package{}, failure("invalid_package", "root SKILL.md is required")
	}
	for name := range seen {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if directory, exists := seen[parent]; exists && !directory {
				return Package{}, failure("invalid_package", "file conflicts with nested path")
			}
		}
	}
	name, description, err := parseManifest(manifest)
	if err != nil {
		return Package{}, err
	}
	result.Name, result.Description = name, description
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	result.ContentDigest = manifestDigest(result.Files)
	return result, nil
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
	if value == "" || len(value) > 512 || !utf8.ValidString(value) || strings.HasPrefix(value, "/") ||
		strings.ContainsAny(value, "\\\x00") {
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

func manifestDigest(files []File) string {
	h := sha256.New()
	_, _ = h.Write([]byte("antnest-skill-manifest-v1\x00"))
	var size [8]byte
	for _, file := range files {
		binary.BigEndian.PutUint32(size[:4], uint32(len(file.Path)))
		_, _ = h.Write(size[:4])
		_, _ = h.Write([]byte(file.Path))
		binary.BigEndian.PutUint64(size[:], file.Size)
		_, _ = h.Write(size[:])
		value, _ := hex.DecodeString(strings.TrimPrefix(file.Digest, "sha256:"))
		_, _ = h.Write(value)
		if file.Executable {
			_, _ = h.Write([]byte{1})
		} else {
			_, _ = h.Write([]byte{0})
		}
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func parseManifest(data []byte) (string, string, error) {
	if !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return "", "", failure("invalid_package", "SKILL.md must be UTF-8 without BOM")
	}
	lines := strings.Split(string(data), "\n")
	line := func(value string) string { return strings.TrimSuffix(value, "\r") }
	if len(lines) < 3 || line(lines[0]) != "---" {
		return "", "", failure("invalid_package", "SKILL.md must begin with exact frontmatter delimiter")
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if line(lines[i]) == "---" {
			end = i
			break
		}
		if line(lines[i]) == "..." {
			return "", "", failure("invalid_package", "YAML document end marker is forbidden")
		}
	}
	if end < 0 {
		return "", "", failure("invalid_package", "SKILL.md frontmatter has no exact closing delimiter")
	}
	header := make([]string, 0, end-1)
	for _, value := range lines[1:end] {
		header = append(header, line(value))
	}
	decoder := yaml.NewDecoder(strings.NewReader(strings.Join(header, "\n")))
	var document yaml.Node
	if err := decoder.Decode(&document); err != nil || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return "", "", failure("invalid_package", "Skill frontmatter must be one mapping")
	}
	var second yaml.Node
	if err := decoder.Decode(&second); err != io.EOF {
		return "", "", failure("invalid_package", "multiple YAML documents are forbidden")
	}
	count := 0
	if err := checkNode(&document, 0, &count); err != nil {
		return "", "", err
	}
	fields := document.Content[0].Content
	var name, description string
	var err error
	for i := 0; i < len(fields); i += 2 {
		key, value := fields[i], fields[i+1]
		switch key.Value {
		case "name":
			name, err = stringField(value)
		case "description":
			description, err = stringField(value)
		}
		if err != nil {
			return "", "", err
		}
	}
	if len(name) < 1 || len(name) > 64 || !namePattern.MatchString(name) {
		return "", "", failure("invalid_package", "invalid Skill name")
	}
	description = strings.TrimSpace(description)
	if description == "" || len(description) > 512 || strings.ContainsRune(description, 0) {
		return "", "", failure("invalid_package", "invalid Skill description")
	}
	return name, description, nil
}

func checkNode(node *yaml.Node, depth int, count *int) error {
	*count += 1
	if depth > 16 || *count > 512 {
		return failure("invalid_package", "YAML nesting or node count exceeds limit")
	}
	if node.Anchor != "" || node.Kind == yaml.AliasNode || node.Style&yaml.TaggedStyle != 0 {
		return failure("invalid_package", "YAML anchors, aliases and explicit tags are forbidden")
	}
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || key.Value == "<<" || seen[key.Value] {
				return failure("invalid_package", "YAML merge or duplicate/nonstring key is forbidden")
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if err := checkNode(child, depth+1, count); err != nil {
			return err
		}
	}
	return nil
}

func stringField(node *yaml.Node) (string, error) {
	if node.Kind != yaml.ScalarNode || node.Tag != "!!str" {
		return "", failure("invalid_package", "Skill name and description must be YAML strings")
	}
	if node.Style&(yaml.SingleQuotedStyle|yaml.DoubleQuotedStyle|yaml.LiteralStyle|yaml.FoldedStyle) == 0 && rejectPlain(node.Value) {
		return "", failure("invalid_package", "plain YAML value is not a portable string")
	}
	return node.Value, nil
}

func rejectPlain(value string) bool {
	lower := strings.ToLower(value)
	if datePattern.MatchString(value) || lower == "true" || lower == "false" || lower == "null" || value == "~" || value == "" {
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
	return strings.Contains(value, "_") && underNumber.MatchString(value)
}
