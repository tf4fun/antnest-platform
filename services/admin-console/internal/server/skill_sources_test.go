package server

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/admin-console/internal/principal"
)

const sourceAgent = "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const sourceRefJSON = `{"kind":"agent","agent_id":"` + sourceAgent + `","name":"code-review","sequence":2}`
const sourceDigest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
const sourceTarget = "skill_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

func sourceSelection(digest string) string {
	return `{"skill_ref":` + sourceRefJSON + `,"expected_digest":"` + digest + `"}`
}

func sourceCall(t *testing.T, h http.Handler, action, body, key string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("POST", "/api/admin/skill-sources/"+action, strings.NewReader(body), "application/json", key))
	return w
}

func TestSkillSourceSearchScopesCallerAndProjectsOnlyAgentMappings(t *testing.T) {
	stub := &skillStub{body: `{"items":[{"skill_ref":` + sourceRefJSON + `,"name":"code-review","description":"Review code","content_digest":"` + sourceDigest + `","owner_id":"private","instructions":"hidden"},{"skill_ref":{"kind":"registry","skill_id":"` + sourceTarget + `","version":1},"name":"code-review","description":"Formal package","content_digest":"` + sourceDigest + `"}],"secret":"hidden"}`}
	w := sourceCall(t, skillHandler(t, stub), "search", `{"query":" review ","limit":50}`, "")
	if w.Code != 200 || len(stub.calls) != 1 {
		t.Fatalf("status=%d calls=%d body=%s", w.Code, len(stub.calls), w.Body.String())
	}
	call := stub.calls[0]
	var in map[string]any
	decodeBytes(t, call.body, &in)
	if call.path != "/internal/skill-discovery/search" || call.query != "" || call.contentType != "application/json" ||
		in["organization_id"] != "org-1" || in["actor_id"] != "user-admin" || in["query"] != "review" || in["limit"] != float64(50) || len(in) != 4 {
		t.Fatalf("call=%+v in=%v", call, in)
	}
	var out struct {
		Items []map[string]any `json:"items"`
	}
	decodeBytes(t, w.Body.Bytes(), &out)
	if len(out.Items) != 1 || strings.Contains(w.Body.String(), "hidden") || strings.Contains(w.Body.String(), "owner_id") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response=%s headers=%v", w.Body.String(), w.Header())
	}
}

func TestSkillSourceRequestsRejectIdentityOverrideAndInvalidSelectionsBeforeDispatch(t *testing.T) {
	stub := &skillStub{body: `{"items":[]}`}
	h := skillHandler(t, stub)
	for _, body := range []string{`null`, `{}`, `{"query":" "}`, `{"query":"review","limit":0}`, `{"query":"review","limit":51}`, `{"query":"review","actor_id":"user-other"}`, `{"query":"review","organization_id":"org-other"}`, `{"query":"` + strings.Repeat("界", 86) + `"}`} {
		w := sourceCall(t, h, "search", body, "")
		if w.Code != 400 {
			t.Fatalf("body=%s status=%d", body, w.Code)
		}
	}
	for _, action := range []string{"preview", "promote"} {
		for _, body := range []string{`null`, `{}`, sourceSelection("sha256:bad"), strings.Replace(sourceSelection(sourceDigest), `"sequence":2`, `"sequence":0`, 1), strings.Replace(sourceSelection(sourceDigest), `"sequence":2`, `"sequence":9007199254740992`, 1), `{"skill_ref":{"kind":"registry","skill_id":"` + sourceTarget + `","version":1},"expected_digest":"` + sourceDigest + `"}`, strings.TrimSuffix(sourceSelection(sourceDigest), "}") + `,"source_url":"http://other/"}`, strings.TrimSuffix(sourceSelection(sourceDigest), "}") + `,"actor_id":"user-other"}`} {
			w := sourceCall(t, h, action, body, "source-attempt-0001")
			if w.Code != 400 {
				t.Fatalf("action=%s body=%s status=%d", action, body, w.Code)
			}
		}
	}
	for _, action := range []string{"search", "preview", "promote"} {
		r := skillRequest("POST", "/api/admin/skill-sources/"+action+"?organization_id=other", strings.NewReader(`{}`), "application/json", "source-attempt-0001")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("query action=%s status=%d", action, w.Code)
		}
		for _, role := range []string{"member", ""} {
			r = skillRequest("POST", "/api/admin/skill-sources/"+action, strings.NewReader(`{}`), "application/json", "source-attempt-0001")
			if role == "" {
				r.Header.Del(principal.HeaderUserID)
			} else {
				r.Header.Set(principal.HeaderOrganizationRole, role)
			}
			w = httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 401 && w.Code != 403 {
				t.Fatalf("role=%s action=%s status=%d", role, action, w.Code)
			}
		}
	}
	if len(stub.calls) != 0 {
		t.Fatalf("dispatched %d invalid requests", len(stub.calls))
	}
}

func TestSkillSourcePromotionBindsReviewedSourceTargetAndStableReceipt(t *testing.T) {
	stub := &skillStub{status: 201, body: `{"skill_id":"` + sourceTarget + `","version":3,"name":"code-review","description":"Review code","artifact_digest":"` + sourceDigest + `","content_digest":"` + sourceDigest + `","artifact_size":100,"unpacked_size":200,"package_rules_version":1,"source_owner":"hidden"}`}
	h := skillHandler(t, stub)
	body := strings.TrimSuffix(sourceSelection(sourceDigest), "}") + `,"skill_id":"` + sourceTarget + `","expected_version":2}`
	for i := 0; i < 2; i++ {
		w := sourceCall(t, h, "promote", body, "source-attempt-0001")
		if w.Code != 201 || strings.Contains(w.Body.String(), "hidden") || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	var requestID string
	for _, call := range stub.calls {
		var in map[string]any
		decodeBytes(t, call.body, &in)
		if call.path != "/internal/skill-projections/promote" || in["organization_id"] != "org-1" || in["actor_id"] != "user-admin" || in["expected_digest"] != sourceDigest || in["skill_id"] != sourceTarget || in["expected_version"] != float64(2) || len(in) != 7 {
			t.Fatalf("input=%v call=%+v", in, call)
		}
		id, _ := in["request_id"].(string)
		if !strings.HasPrefix(id, "skill-") || requestID != "" && id != requestID {
			t.Fatalf("unstable request=%v", in)
		}
		requestID = id
	}
	before := len(stub.calls)
	for _, extra := range []string{`,"skill_id":"` + sourceTarget + `"`, `,"expected_version":2`, `,"skill_id":null,"expected_version":null`, `,"skill_id":"` + sourceTarget + `","expected_version":0`, `,"skill_id":"` + sourceTarget + `","expected_version":9007199254740992`} {
		w := sourceCall(t, h, "promote", strings.TrimSuffix(sourceSelection(sourceDigest), "}")+extra+"}", "source-attempt-0001")
		if w.Code != 400 {
			t.Fatalf("extra=%s status=%d", extra, w.Code)
		}
	}
	if len(stub.calls) != before {
		t.Fatal("invalid append was dispatched")
	}
}

// The fixture uses the published v1 manifest encoding, independently of the BFF.
func sourceArchive(t *testing.T, text string) (string, string, string) {
	t.Helper()
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	entry, err := writer.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte(text)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	fileHash := sha256.Sum256([]byte(text))
	zipHash := sha256.Sum256(archive.Bytes())
	var manifest bytes.Buffer
	manifest.WriteString("antnest-skill-manifest-v1\x00")
	if err := binary.Write(&manifest, binary.BigEndian, uint32(8)); err != nil {
		t.Fatal(err)
	}
	manifest.WriteString("SKILL.md")
	if err := binary.Write(&manifest, binary.BigEndian, uint64(len(text))); err != nil {
		t.Fatal(err)
	}
	manifest.Write(fileHash[:])
	manifest.WriteByte(0)
	contentHash := sha256.Sum256(manifest.Bytes())
	return archive.String(), "sha256:" + hex.EncodeToString(zipHash[:]), "sha256:" + hex.EncodeToString(contentHash[:])
}

func TestSkillSourcePreviewVerifiesPackageAndReturnsTextWithoutInstallation(t *testing.T) {
	text := "---\nname: code-review\ndescription: Review code\n---\nReview carefully. <script>bad()</script>\n"
	archive, artifactDigest, digest := sourceArchive(t, text)
	stub := &skillStub{body: archive, contentType: "application/zip", digest: artifactDigest, headers: http.Header{"X-Antnest-Content-Digest": []string{digest}}}
	w := sourceCall(t, skillHandler(t, stub), "preview", sourceSelection(digest), "")
	if w.Code != 200 || len(stub.calls) != 1 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var out struct {
		SkillMD       string `json:"skill_md"`
		ContentDigest string `json:"content_digest"`
		Files         []struct {
			Path       string `json:"path"`
			Size       int    `json:"size"`
			Executable bool   `json:"executable"`
		} `json:"files"`
	}
	decodeBytes(t, w.Body.Bytes(), &out)
	if out.SkillMD != text || out.ContentDigest != digest || len(out.Files) != 1 || out.Files[0].Path != "SKILL.md" || out.Files[0].Size != len(text) || out.Files[0].Executable || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("output=%+v", out)
	}
	var in map[string]any
	decodeBytes(t, stub.calls[0].body, &in)
	if stub.calls[0].path != "/internal/skill-discovery/load" || in["actor_id"] != "user-admin" || in["organization_id"] != "org-1" || in["expected_digest"] != digest || len(in) != 4 {
		t.Fatalf("call=%+v input=%v", stub.calls[0], in)
	}
}

func TestSkillSourcePreviewRejectsTamperedAndOversizedPackages(t *testing.T) {
	archive, artifactDigest, digest := sourceArchive(t, "---\nname: code-review\ndescription: Review\n---\nText\n")
	for _, scenario := range []struct{ name, body, artifactDigest, contentDigest, media string }{
		{"wrong artifact", archive, sourceDigest, digest, "application/zip"},
		{"wrong content header", archive, artifactDigest, sourceDigest, "application/zip"},
		{"wrong canonical content", archive, artifactDigest, sourceDigest, "application/zip"},
		{"wrong media", archive, artifactDigest, digest, "application/json"},
		{"oversized archive", strings.Repeat("x", maximumSkillUpload+1), artifactDigest, digest, "application/zip"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub := &skillStub{body: scenario.body, digest: scenario.artifactDigest, contentType: scenario.media, headers: http.Header{"X-Antnest-Content-Digest": []string{scenario.contentDigest}}}
			selected := digest
			if scenario.name == "wrong canonical content" {
				selected = sourceDigest
			}
			w := sourceCall(t, skillHandler(t, stub), "preview", sourceSelection(selected), "")
			if w.Code != 502 || strings.Contains(w.Body.String(), "Text") {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
	for _, text := range []string{strings.Repeat("x", 16385), string([]byte{0xff, 0xfe})} {
		archive, artifactDigest, digest = sourceArchive(t, text)
		stub := &skillStub{body: archive, digest: artifactDigest, contentType: "application/zip", headers: http.Header{"X-Antnest-Content-Digest": []string{digest}}}
		if w := sourceCall(t, skillHandler(t, stub), "preview", sourceSelection(digest), ""); w.Code != 502 {
			t.Fatalf("oversized/invalid text status=%d", w.Code)
		}
	}
}

func TestSkillSourceDependencyErrorsRemainBoundedAndDoNotExpireSession(t *testing.T) {
	for _, scenario := range []struct {
		upstream, want int
		code           string
	}{{409, 409, "content_changed"}, {409, 409, "revision_conflict"}, {404, 404, "not_found"}, {503, 503, "source_unavailable"}, {502, 502, "source_invalid"}, {401, 503, "unauthorized"}, {500, 502, "secret_internal_error"}} {
		stub := &skillStub{status: scenario.upstream, body: `{"error":{"code":"` + scenario.code + `","message":"Review again"}}`}
		w := sourceCall(t, skillHandler(t, stub), "promote", sourceSelection(sourceDigest), "source-attempt-0001")
		if w.Code != scenario.want || scenario.upstream == 401 && strings.Contains(w.Body.String(), "unauthorized") {
			t.Fatalf("code=%s status=%d body=%s", scenario.code, w.Code, w.Body.String())
		}
	}
}

func TestSkillSourceSearchRejectsMalformedUpstreamReferences(t *testing.T) {
	base := `{"skill_ref":` + sourceRefJSON + `,"name":"code-review","description":"Review code","content_digest":"` + sourceDigest + `"}`
	for _, item := range []string{strings.Replace(base, `"sequence":2`, `"sequence":0`, 1), strings.Replace(base, `"name":"code-review","description"`, `"name":"other","description"`, 1), strings.Replace(base, sourceDigest, "sha256:bad", 1), strings.Replace(base, `"sequence":2`, `"sequence":2,"skill_id":"`+sourceTarget+`"`, 1)} {
		stub := &skillStub{body: `{"items":[` + item + `]}`}
		w := sourceCall(t, skillHandler(t, stub), "search", `{"query":"review"}`, "")
		if w.Code != 502 {
			t.Fatalf("item=%s status=%d body=%s", item, w.Code, w.Body.String())
		}
	}
}

func TestSkillSourcePromotionDoesNotAcceptMismatchedVersionReceipt(t *testing.T) {
	stub := &skillStub{status: 201, body: `{"skill_id":"` + sourceTarget + `","version":1,"name":"other","description":"Review","artifact_digest":"` + sourceDigest + `","content_digest":"` + sourceDigest + `","artifact_size":100,"unpacked_size":200,"package_rules_version":1}`}
	w := sourceCall(t, skillHandler(t, stub), "promote", sourceSelection(sourceDigest), "source-attempt-0001")
	if w.Code != 502 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestSkillSourceRequestsAreBoundedAndPromotionHasNoAutomaticRetry(t *testing.T) {
	stub := &skillStub{body: `{"items":[]}`}
	h := skillHandler(t, stub)
	w := sourceCall(t, h, "search", `{"query":"review"}`+strings.Repeat(" ", 4096), "")
	if w.Code != 400 || len(stub.calls) != 0 {
		t.Fatalf("oversized status=%d calls=%d", w.Code, len(stub.calls))
	}
	h.(*handler).skillUploads <- struct{}{}
	h.(*handler).skillUploads <- struct{}{}
	for _, action := range []string{"preview", "promote"} {
		w = sourceCall(t, h, action, sourceSelection(sourceDigest), "source-attempt-0001")
		if w.Code != 429 || len(stub.calls) != 0 {
			t.Fatalf("action=%s status=%d", action, w.Code)
		}
	}
}
