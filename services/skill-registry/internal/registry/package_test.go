package registry

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
)

type cutoffContext struct {
	context.Context
	checks int
}

func (c *cutoffContext) Err() error {
	c.checks++
	if c.checks >= 5 {
		return context.Canceled
	}
	return nil
}

func TestValidatePackageStopsDuringDecompression(t *testing.T) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	manifest, _ := writer.Create("SKILL.md")
	_, _ = manifest.Write([]byte("---\nname: test\ndescription: Helpful review\n---\n"))
	asset, _ := writer.Create("assets/large.bin")
	_, _ = asset.Write(bytes.Repeat([]byte("x"), 3<<20))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	_, err := ValidatePackage(&cutoffContext{Context: context.Background()}, output.Bytes())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("decompression ignored cancellation: %v", err)
	}
}

func TestSharedPackageRulesV1(t *testing.T) {
	data, err := os.ReadFile("../../../../tests/integration/skill-registry/package-rules-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		PackageRulesVersion int `json:"package_rules_version"`
		Cases               []struct {
			ID, Manifest, Name string
			Accept             bool
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil || fixture.PackageRulesVersion != PackageRulesVersion {
		t.Fatalf("shared fixture version or JSON: %d, %v", fixture.PackageRulesVersion, err)
	}
	for _, candidate := range fixture.Cases {
		t.Run(candidate.ID, func(t *testing.T) {
			pkg, err := ValidatePackage(context.Background(), skillZIP(t, candidate.Manifest))
			if candidate.Accept && (err != nil || pkg.Name != candidate.Name) {
				t.Fatalf("rejected shared valid case: %v, %#v", err, pkg)
			}
			if !candidate.Accept && Code(err) != "invalid_package" {
				t.Fatalf("accepted shared invalid case: %v, %#v", err, pkg)
			}
		})
	}
}

func skillZIP(t *testing.T, manifest string) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	file, err := writer.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(manifest)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestValidatePackageAcceptsRuntimeStrings(t *testing.T) {
	for _, name := range []string{"code-review", "0x-1", "0o-7", "2024-01-01"} {
		t.Run(name, func(t *testing.T) {
			manifest := "---\nname: \"" + name + "\"\ndescription: Helpful review\n---\nInstructions.\n"
			item, err := ValidatePackage(context.Background(), skillZIP(t, manifest))
			if err != nil {
				t.Fatal(err)
			}
			if item.Name != name || item.Description != "Helpful review" || len(item.Files) != 1 || item.Files[0].Path != "SKILL.md" {
				t.Fatalf("unexpected package: %#v", item)
			}
			if !strings.HasPrefix(item.ArtifactDigest, "sha256:") || !strings.HasPrefix(item.ContentDigest, "sha256:") {
				t.Fatalf("missing digest: %#v", item)
			}
		})
	}
}

func TestValidatePackageRejectsCrossParserPlainValues(t *testing.T) {
	for _, value := range []string{
		"0x-1", "0x+1f", "0o-7", "++42", "+-42", "0X-1", "0Btext", "0xnote",
		"True", "NULL", "0b101", "1_000", "2024-01-01", ".Inf", "123", "null",
	} {
		t.Run(value, func(t *testing.T) {
			_, err := ValidatePackage(context.Background(), skillZIP(t, "---\nname: code-review\ndescription: "+value+"\n---\n"))
			if Code(err) != "invalid_package" {
				t.Fatalf("value %q: got %v", value, err)
			}
		})
	}
}

func TestValidatePackageRejectsMergeAndMalformedFrontmatter(t *testing.T) {
	for _, header := range []string{
		"---\n<<: {name: code-review}\ndescription: valid\n---\n",
		"---\n\"<<\": {name: code-review}\nname: code-review\ndescription: valid\n---\n",
		"---\nname: code-review\ndescription: valid\nname: again\n---\n",
		"\ufeff---\nname: code-review\ndescription: valid\n---\n",
		"--- \nname: code-review\ndescription: valid\n---\n",
		"---\nname: code-review\ndescription: valid\n--- \n",
		"---\nname: !!str code-review\ndescription: valid\n---\n",
	} {
		_, err := ValidatePackage(context.Background(), skillZIP(t, header))
		if Code(err) != "invalid_package" {
			t.Fatalf("accepted %q: %v", header, err)
		}
	}
}

func TestValidatePackageRejectsUnsafeZIPEntries(t *testing.T) {
	for _, path := range []string{"../SKILL.md", "/SKILL.md", "a\\b", "a/./b", "a//b"} {
		t.Run(path, func(t *testing.T) {
			var output bytes.Buffer
			writer := zip.NewWriter(&output)
			for _, entry := range []struct{ name, data string }{
				{"SKILL.md", "---\nname: test\ndescription: test\n---\n"},
				{path, "unsafe"},
			} {
				file, err := writer.Create(entry.name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.Write([]byte(entry.data)); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := ValidatePackage(context.Background(), output.Bytes()); Code(err) != "invalid_package" {
				t.Fatalf("accepted path %q: %v", path, err)
			}
		})
	}
}

func TestValidatePackageRejectsLinkMetadata(t *testing.T) {
	for _, variant := range []string{"symlink", "unix-extra"} {
		t.Run(variant, func(t *testing.T) {
			var output bytes.Buffer
			writer := zip.NewWriter(&output)
			base, err := writer.Create("SKILL.md")
			if err != nil {
				t.Fatal(err)
			}
			_, _ = base.Write([]byte("---\nname: test\ndescription: test\n---\n"))
			header := &zip.FileHeader{Name: "references/item", Method: zip.Store}
			if variant == "symlink" {
				header.SetMode(os.ModeSymlink | 0644)
			} else {
				header.SetMode(0644)
				header.Extra = []byte{0x6e, 0x75, 0x00, 0x00} // ASi Unix metadata
			}
			entry, err := writer.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = entry.Write([]byte("target"))
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := ValidatePackage(context.Background(), output.Bytes()); Code(err) != "invalid_package" {
				t.Fatalf("accepted link metadata: %v", err)
			}
		})
	}
}

func TestValidatePackageRejectsCorruptCRC(t *testing.T) {
	archive := skillZIP(t, "---\nname: test\ndescription: Helpful review\n---\n")
	position := bytes.Index(archive, []byte("Helpful"))
	if position < 0 {
		// skillZIP uses deflate; build an uncompressed entry for a stable corruption point.
		var output bytes.Buffer
		writer := zip.NewWriter(&output)
		header := &zip.FileHeader{Name: "SKILL.md", Method: zip.Store}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = entry.Write([]byte("---\nname: test\ndescription: Helpful review\n---\n"))
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		archive = output.Bytes()
		position = bytes.Index(archive, []byte("Helpful"))
	}
	if position < 0 {
		t.Fatal("could not locate stored ZIP payload")
	}
	archive[position] ^= 1
	if _, err := ValidatePackage(context.Background(), archive); Code(err) != "invalid_package" {
		t.Fatalf("accepted corrupt ZIP: %v", err)
	}
}

func TestValidatePackageRejectsCapacityLimits(t *testing.T) {
	manifest := []byte("---\nname: code-review\ndescription: Review code\n---\n")
	type zipMember struct {
		name string
		data []byte
	}
	archive := func(t *testing.T, files []zipMember) []byte {
		t.Helper()
		var output bytes.Buffer
		writer := zip.NewWriter(&output)
		for _, file := range files {
			entry, err := writer.Create(file.name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := entry.Write(file.data); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return output.Bytes()
	}
	for _, scenario := range []struct {
		name string
		data func(*testing.T) []byte
	}{
		{"compressed ZIP over 8 MiB", func(*testing.T) []byte { return make([]byte, MaxArtifactBytes+1) }},
		{"SKILL.md over 16 KiB", func(t *testing.T) []byte {
			return archive(t, []zipMember{{"SKILL.md", append(append([]byte(nil), manifest...), bytes.Repeat([]byte("x"), MaxSkillBytes-len(manifest)+1)...)}})
		}},
		{"one file over 8 MiB", func(t *testing.T) []byte {
			return archive(t, []zipMember{{"SKILL.md", manifest}, {"references/large", bytes.Repeat([]byte("x"), MaxArtifactBytes+1)}})
		}},
		{"unpacked total over 32 MiB", func(t *testing.T) []byte {
			files := []zipMember{{"SKILL.md", manifest}}
			payload := bytes.Repeat([]byte("x"), 7<<20)
			for i := 0; i < 5; i++ {
				files = append(files, zipMember{"references/file-" + strconv.Itoa(i), payload})
			}
			return archive(t, files)
		}},
		{"over 256 entries", func(t *testing.T) []byte {
			files := []zipMember{{"SKILL.md", manifest}}
			for i := 0; i < MaxFiles; i++ {
				files = append(files, zipMember{"references/file-" + strconv.Itoa(i), []byte("x")})
			}
			return archive(t, files)
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			if _, err := ValidatePackage(context.Background(), scenario.data(t)); Code(err) != "limit_exceeded" {
				t.Fatalf("oversized package result: %v", err)
			}
		})
	}
}
