package server

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

type resourceIDVectors struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func readResourceIDVectors(t *testing.T) map[string]resourceIDVectors {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/common/id-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors map[string]resourceIDVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func TestResourceIDSharedVectors(t *testing.T) {
	vectors := readResourceIDVectors(t)
	for _, value := range vectors["agentId"].Accept {
		if !validAgentSkillSource(agentSkillSourceRef{Kind: "agent", AgentID: value, Name: "code-review", Sequence: 1}) {
			t.Errorf("agentId must accept %q", value)
		}
	}
	for _, value := range vectors["agentId"].Reject {
		if validAgentSkillSource(agentSkillSourceRef{Kind: "agent", AgentID: value, Name: "code-review", Sequence: 1}) {
			t.Errorf("agentId must reject %q", value)
		}
	}
	for _, kind := range []string{"organizationId", "userId"} {
		for _, value := range vectors[kind].Accept {
			if !browserSessionPublicID.MatchString(value) {
				t.Errorf("%s session identifier must accept %q", kind, value)
			}
			if !runtimeRecoveryIdentifier.MatchString(value) {
				t.Errorf("%s recovery identifier must accept %q", kind, value)
			}
		}
		for _, value := range vectors[kind].Reject {
			if browserSessionPublicID.MatchString(value) {
				t.Errorf("%s session identifier must reject %q", kind, value)
			}
			if runtimeRecoveryIdentifier.MatchString(value) {
				t.Errorf("%s recovery identifier must reject %q", kind, value)
			}
		}
	}
}

func TestResourceIDSkillSourceAgentIsOpaqueAcrossSearchPreviewAndPromote(t *testing.T) {
	const opaqueAgent = "Legacy.Agent_9"
	refJSON := `{"kind":"agent","agent_id":"` + opaqueAgent + `","name":"code-review","sequence":2}`
	selection := `{"skill_ref":` + refJSON + `,"expected_digest":"` + sourceDigest + `"}`
	invalidSelection := strings.Replace(selection, opaqueAgent, "agent/embedded", 1)

	searchStub := &skillStub{body: `{"items":[{"skill_ref":` + refJSON + `,"name":"code-review","description":"Review code","content_digest":"` + sourceDigest + `"}]}`}
	w := sourceCall(t, skillHandler(t, searchStub), "search", `{"query":"review"}`, "")
	if w.Code != http.StatusOK {
		t.Fatalf("search with opaque Agent: status=%d body=%s", w.Code, w.Body.String())
	}
	var page struct {
		Items []struct {
			SkillRef struct {
				AgentID string `json:"agent_id"`
			} `json:"skill_ref"`
		} `json:"items"`
	}
	decodeBytes(t, w.Body.Bytes(), &page)
	if len(page.Items) != 1 || page.Items[0].SkillRef.AgentID != opaqueAgent {
		t.Fatalf("search did not project the opaque Agent verbatim: %+v", page.Items)
	}

	text := "---\nname: code-review\ndescription: Review code\n---\nReview carefully.\n"
	archive, artifactDigest, digest := sourceArchive(t, text)
	previewStub := &skillStub{body: archive, contentType: "application/zip", digest: artifactDigest, headers: http.Header{"X-Antnest-Content-Digest": []string{digest}}}
	previewSelection := strings.Replace(selection, sourceDigest, digest, 1)
	w = sourceCall(t, skillHandler(t, previewStub), "preview", previewSelection, "")
	if w.Code != http.StatusOK || len(previewStub.calls) != 1 {
		t.Fatalf("preview with opaque Agent: status=%d body=%s", w.Code, w.Body.String())
	}
	var preview struct {
		SkillMD string `json:"skill_md"`
	}
	decodeBytes(t, w.Body.Bytes(), &preview)
	if preview.SkillMD != text {
		t.Fatalf("preview text altered: %q", preview.SkillMD)
	}
	var forwarded map[string]any
	decodeBytes(t, previewStub.calls[0].body, &forwarded)
	if ref, ok := forwarded["skill_ref"].(map[string]any); !ok || ref["agent_id"] != opaqueAgent ||
		forwarded["organization_id"] != "org-1" || forwarded["actor_id"] != "user-admin" {
		t.Fatalf("preview forwarded altered identity: %v", forwarded)
	}

	promoteStub := &skillStub{status: 201, body: `{"skill_id":"` + sourceTarget + `","version":1,"name":"code-review","description":"Review code","artifact_digest":"` + sourceDigest + `","content_digest":"` + sourceDigest + `","artifact_size":100,"unpacked_size":200,"package_rules_version":1,"source_owner":"hidden"}`}
	h := skillHandler(t, promoteStub)
	w = sourceCall(t, h, "promote", selection, "source-attempt-0001")
	if w.Code != 201 || strings.Contains(w.Body.String(), "hidden") {
		t.Fatalf("promote with opaque Agent: status=%d body=%s", w.Code, w.Body.String())
	}
	decodeBytes(t, promoteStub.calls[0].body, &forwarded)
	if ref, ok := forwarded["skill_ref"].(map[string]any); !ok || ref["agent_id"] != opaqueAgent ||
		forwarded["organization_id"] != "org-1" || forwarded["actor_id"] != "user-admin" {
		t.Fatalf("promote forwarded altered identity: %v", forwarded)
	}

	before := len(promoteStub.calls)
	for _, action := range []string{"preview", "promote"} {
		w := sourceCall(t, h, action, invalidSelection, "source-attempt-0001")
		if w.Code != 400 {
			t.Fatalf("action=%s invalid Agent status=%d", action, w.Code)
		}
	}
	if len(promoteStub.calls) != before {
		t.Fatalf("dispatched %d requests carrying invalid Agent references", len(promoteStub.calls)-before)
	}
	malformed := &skillStub{body: `{"items":[{"skill_ref":{"kind":"agent","agent_id":"agent/embedded","name":"code-review","sequence":2},"name":"code-review","description":"Review code","content_digest":"` + sourceDigest + `"}]}`}
	if w := sourceCall(t, skillHandler(t, malformed), "search", `{"query":"review"}`, ""); w.Code != 502 {
		t.Fatalf("malformed upstream Agent reference: status=%d body=%s", w.Code, w.Body.String())
	}
}
