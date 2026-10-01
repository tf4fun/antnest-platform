package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestSkillCollectionScanRejectsUnexpectedRootEntry(t *testing.T) {
	key := skillset.SetKey{Scope: "test", OrganizationID: "org_00000000000000000000000000000000", AgentID: "agent-1", SkillSetDigest: "sha256:" + strings.Repeat("a", 64), LayoutVersion: 1, Materialization: 1}
	manifest := []byte(`{"layout_version":1,"organization_id":"org_00000000000000000000000000000000","agent_id":"agent-1","skill_set_digest":"sha256:` + strings.Repeat("a", 64) + `","skills":[{"name":"code-review","files":[{"path":"SKILL.md","size":3,"digest":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","executable":false}]}]}`)
	makeArchive := func(extra bool) []byte {
		var body bytes.Buffer
		writer := tar.NewWriter(&body)
		entries := []tar.Header{{Name: "skills/", Typeflag: tar.TypeDir, Mode: 0755}, {Name: "skills/code-review/", Typeflag: tar.TypeDir, Mode: 0555}, {Name: "skills/code-review/SKILL.md", Typeflag: tar.TypeReg, Mode: 0444, Size: 3}, {Name: "skills/.antnest-skills.json", Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(manifest))}}
		if extra {
			entries = append(entries, tar.Header{Name: "skills/rogue/", Typeflag: tar.TypeDir, Mode: 0555})
		}
		for _, entry := range entries {
			if err := writer.WriteHeader(&entry); err != nil {
				t.Fatal(err)
			}
			if entry.Name == "skills/code-review/SKILL.md" {
				_, _ = writer.Write([]byte("abc"))
			}
			if entry.Name == "skills/.antnest-skills.json" {
				_, _ = writer.Write(manifest)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return body.Bytes()
	}
	if err := verifyCollectionArchive(context.Background(), bytes.NewReader(makeArchive(false)), key, manifest); err != nil {
		t.Fatalf("valid set rejected: %v", err)
	}
	if err := verifyCollectionArchive(context.Background(), bytes.NewReader(makeArchive(true)), key, manifest); err == nil {
		t.Fatal("unexpected root Skill was accepted")
	}
}

func TestSkillCollectionScanAcceptsEmptySetAndRejectsHiddenFile(t *testing.T) {
	key := skillset.SetKey{Scope: "test", OrganizationID: "org_00000000000000000000000000000000", AgentID: "agent-1", SkillSetDigest: "sha256:" + strings.Repeat("a", 64), LayoutVersion: 1, Materialization: 1}
	manifest := []byte(`{"layout_version":1,"organization_id":"org_00000000000000000000000000000000","agent_id":"agent-1","skill_set_digest":"sha256:` + strings.Repeat("a", 64) + `","skills":[]}`)
	archive := func(hidden bool) []byte {
		var body bytes.Buffer
		writer := tar.NewWriter(&body)
		_ = writer.WriteHeader(&tar.Header{Name: "skills/", Typeflag: tar.TypeDir, Mode: 0755})
		_ = writer.WriteHeader(&tar.Header{Name: "skills/.antnest-skills.json", Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(manifest))})
		_, _ = writer.Write(manifest)
		if hidden {
			_ = writer.WriteHeader(&tar.Header{Name: "skills/.hidden", Typeflag: tar.TypeReg, Mode: 0444, Size: 1})
			_, _ = writer.Write([]byte("x"))
		}
		_ = writer.Close()
		return body.Bytes()
	}
	if err := verifyCollectionArchive(context.Background(), bytes.NewReader(archive(false)), key, manifest); err != nil {
		t.Fatal(err)
	}
	if err := verifyCollectionArchive(context.Background(), bytes.NewReader(archive(true)), key, manifest); err == nil {
		t.Fatal("hidden extra file was accepted")
	}
}
