package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

type skillCall struct {
	method, path, query, contentType string
	body                             []byte
}

type skillStub struct {
	calls       []skillCall
	status      int
	body        string
	contentType string
	digest      string
	headers     http.Header
}

func (stub *skillStub) Do(_ context.Context, method, path, query, contentType string, body []byte) (*http.Response, error) {
	stub.calls = append(stub.calls, skillCall{method, path, query, contentType, append([]byte(nil), body...)})
	status := stub.status
	if status == 0 {
		status = http.StatusOK
	}
	media := stub.contentType
	if media == "" {
		media = "application/json"
	}
	headers := http.Header{"Content-Type": []string{media}, "X-Antnest-Artifact-Digest": []string{stub.digest}}
	for key, values := range stub.headers {
		headers[key] = append([]string(nil), values...)
	}
	return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(stub.body))}, nil
}

func skillHandler(t *testing.T, stub *skillStub) http.Handler {
	t.Helper()
	h, err := NewHandler(Config{}, Dependencies{Backend: newBackendStub(), Registry: stub,
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func skillRequest(method, path string, body io.Reader, contentType, key string) *http.Request {
	r := httptest.NewRequest(method, path, body)
	r.Header.Set(principal.HeaderUserID, "user-admin")
	r.Header.Set(principal.HeaderOrganizationID, "org-1")
	r.Header.Set(principal.HeaderMembershipID, "membership-1")
	r.Header.Set(principal.HeaderSystemRole, "user")
	r.Header.Set(principal.HeaderOrganizationRole, "admin")
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	return r
}

func TestSkillListScopesAndProjectsRegistryResponse(t *testing.T) {
	stub := &skillStub{body: `{"items":[{"skill_id":"skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"review","current_version":2,"description":"Review","artifact_digest":"sha256:a","content_digest":"sha256:b","artifact_size":100,"unpacked_size":200,"package_rules_version":1,"private":"secret"}],"next_after_id":"skill_cursor"}`}
	h := skillHandler(t, stub)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("GET", "/api/admin/skills?after_id=skill_old&limit=20", nil, "", ""))
	if w.Code != 200 || len(stub.calls) != 1 {
		t.Fatalf("status=%d calls=%d body=%s", w.Code, len(stub.calls), w.Body.String())
	}
	if stub.calls[0].path != "/internal/skills" || stub.calls[0].query != "after_id=skill_old&limit=20&organization_id=org-1" {
		t.Fatalf("call=%+v", stub.calls[0])
	}
	if strings.Contains(w.Body.String(), "private") || !strings.Contains(w.Body.String(), "review") {
		t.Fatalf("projection=%s", w.Body.String())
	}
	for _, path := range []string{"/api/admin/skills?organization_id=org-2", "/api/admin/skills?limit=101", "/api/admin/skills?after_id=a&after_id=b"} {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, skillRequest("GET", path, nil, "", ""))
		if w.Code != 400 || len(stub.calls) != 1 {
			t.Fatalf("path=%s status=%d calls=%d", path, w.Code, len(stub.calls))
		}
	}
}

func TestSkillRegistryTerminalCursorsBecomeBrowserNull(t *testing.T) {
	for _, scenario := range []struct{ path, body, cursor string }{
		{"/api/admin/skills", `{"items":[],"next_after_id":""}`, "next_after_id"},
		{"/api/admin/skills/skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/versions", `{"items":[{"skill_id":"skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":1,"name":"review","description":"Review","artifact_digest":"sha256:a","content_digest":"sha256:b","artifact_size":100,"unpacked_size":200,"package_rules_version":1}],"next_after_version":0}`, "next_after_version"},
	} {
		t.Run(scenario.cursor, func(t *testing.T) {
			stub := &skillStub{body: scenario.body}
			w := httptest.NewRecorder()
			skillHandler(t, stub).ServeHTTP(w, skillRequest("GET", scenario.path, nil, "", ""))
			var page map[string]any
			decodeBytes(t, w.Body.Bytes(), &page)
			if w.Code != 200 || page[scenario.cursor] != nil {
				t.Fatalf("status=%d page=%v", w.Code, page)
			}
		})
	}
}

func TestSkillPublishUsesTrustedActorAndStableRequestID(t *testing.T) {
	stub := &skillStub{status: 201, body: `{"skill_id":"skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":1,"name":"review","description":"Review","artifact_digest":"sha256:a","content_digest":"sha256:b","artifact_size":100,"unpacked_size":200,"package_rules_version":1,"private":"secret"}`}
	h := skillHandler(t, stub)
	makeBody := func() (*bytes.Buffer, string) {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, _ := writer.CreateFormFile("artifact", "review.zip")
		_, _ = part.Write([]byte("zip bytes"))
		_ = writer.Close()
		return &body, writer.FormDataContentType()
	}
	for i := 0; i < 2; i++ {
		body, media := makeBody()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, skillRequest("POST", "/api/admin/skills", body, media, "upload-attempt-0001"))
		if w.Code != 201 || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	if len(stub.calls) != 2 {
		t.Fatalf("calls=%d", len(stub.calls))
	}
	var ids []string
	for _, call := range stub.calls {
		if call.method != "POST" || call.path != "/internal/skills" || !strings.HasPrefix(call.contentType, "multipart/form-data;") {
			t.Fatalf("call=%+v", call)
		}
		request := httptest.NewRequest("POST", "/", bytes.NewReader(call.body))
		request.Header.Set("Content-Type", call.contentType)
		if err := request.ParseMultipartForm(10 << 20); err != nil {
			t.Fatal(err)
		}
		var metadata map[string]any
		if err := json.Unmarshal([]byte(request.FormValue("metadata")), &metadata); err != nil {
			t.Fatal(err)
		}
		if metadata["organization_id"] != "org-1" || metadata["actor_id"] != "user-admin" || len(metadata) != 3 {
			t.Fatalf("metadata=%v", metadata)
		}
		ids = append(ids, metadata["request_id"].(string))
	}
	if ids[0] != ids[1] {
		t.Fatalf("unstable request IDs: %v", ids)
	}
}

func TestSkillRoutesRejectMissingOrNonAdminPrincipal(t *testing.T) {
	stub := &skillStub{body: `{"items":[]}`}
	h := skillHandler(t, stub)
	for _, role := range []string{"", "member"} {
		r := skillRequest("GET", "/api/admin/skills", nil, "", "")
		if role == "" {
			r.Header.Del(principal.HeaderUserID)
		} else {
			r.Header.Set(principal.HeaderOrganizationRole, role)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 && w.Code != 403 {
			t.Fatalf("role=%q status=%d", role, w.Code)
		}
	}
	if len(stub.calls) != 0 {
		t.Fatalf("unauthorized calls=%d", len(stub.calls))
	}
}

func TestSkillVersionsAndRevisionUseTrustedScopeAndExpectedHead(t *testing.T) {
	id := "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	stub := &skillStub{body: `{"items":[{"skill_id":"` + id + `","version":1,"name":"review","description":"Review","artifact_digest":"sha256:a","content_digest":"sha256:b","artifact_size":100,"unpacked_size":200,"package_rules_version":1,"secret":"hidden"}],"next_after_version":null}`}
	h := skillHandler(t, stub)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("GET", "/api/admin/skills/"+id+"/versions?after_version=2", nil, "", ""))
	if w.Code != 200 || strings.Contains(w.Body.String(), "hidden") || stub.calls[0].query != "after_version=2&organization_id=org-1" {
		t.Fatalf("status=%d body=%s call=%+v", w.Code, w.Body.String(), stub.calls[0])
	}
	stub.status = 201
	stub.body = `{"skill_id":"` + id + `","version":2,"name":"review","description":"Review","artifact_digest":"sha256:a","content_digest":"sha256:b","artifact_size":100,"unpacked_size":200,"package_rules_version":1}`
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("expected_version", "1")
	part, _ := writer.CreateFormFile("artifact", "review.zip")
	_, _ = part.Write([]byte("zip bytes"))
	_ = writer.Close()
	w = httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("POST", "/api/admin/skills/"+id+"/versions", &body, writer.FormDataContentType(), "revision-attempt-0001"))
	if w.Code != 201 || len(stub.calls) != 2 {
		t.Fatalf("status=%d calls=%d body=%s", w.Code, len(stub.calls), w.Body.String())
	}
	request := httptest.NewRequest("POST", "/", bytes.NewReader(stub.calls[1].body))
	request.Header.Set("Content-Type", stub.calls[1].contentType)
	if err := request.ParseMultipartForm(10 << 20); err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	if err := json.Unmarshal([]byte(request.FormValue("metadata")), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["expected_version"] != float64(1) || metadata["organization_id"] != "org-1" {
		t.Fatalf("metadata=%v", metadata)
	}
}

func TestSkillRegistryErrorsAndInvalidUploads(t *testing.T) {
	stub := &skillStub{status: 409, body: `{"error":{"code":"revision_conflict","message":"Current version changed"}}`}
	h := skillHandler(t, stub)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("GET", "/api/admin/skills", nil, "", ""))
	if w.Code != 409 || !strings.Contains(w.Body.String(), "revision_conflict") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	stub.status = 401
	w = httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("GET", "/api/admin/skills", nil, "", ""))
	if w.Code != 503 || strings.Contains(w.Body.String(), "unauthenticated") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	before := len(stub.calls)
	for _, path := range []string{"/api/admin/skills/other/versions", "/api/admin/skills/skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/versions?organization_id=org-2"} {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, skillRequest("GET", path, nil, "", ""))
		if w.Code != 400 {
			t.Fatalf("path=%s status=%d", path, w.Code)
		}
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("organization_id", "org-2")
	part, _ := writer.CreateFormFile("artifact", "review.zip")
	_, _ = part.Write([]byte("zip bytes"))
	_ = writer.Close()
	w = httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("POST", "/api/admin/skills", &body, writer.FormDataContentType(), "upload-attempt-0001"))
	if w.Code != 400 || len(stub.calls) != before {
		t.Fatalf("status=%d calls=%d", w.Code, len(stub.calls))
	}
}

func TestSkillUploadCapacityRejectsBeforeReadingArtifact(t *testing.T) {
	stub := &skillStub{body: `{}`}
	h := skillHandler(t, stub).(*handler)
	h.skillUploads <- struct{}{}
	h.skillUploads <- struct{}{}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("POST", "/api/admin/skills", strings.NewReader("not a multipart body"), "multipart/form-data; boundary=missing", "upload-attempt-0001"))
	if w.Code != 429 || len(stub.calls) != 0 {
		t.Fatalf("status=%d calls=%d", w.Code, len(stub.calls))
	}
}

func TestSkillArtifactDownloadChecksDigestAndScope(t *testing.T) {
	id := "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	data := "synthetic ZIP bytes"
	hash := sha256.Sum256([]byte(data))
	stub := &skillStub{body: data, contentType: "application/zip", digest: "sha256:" + hex.EncodeToString(hash[:])}
	h := skillHandler(t, stub)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("GET", "/api/admin/skills/"+id+"/versions/2/artifact", nil, "", ""))
	if w.Code != 200 || w.Body.String() != data || w.Header().Get("Content-Disposition") != "attachment; filename=\""+id+"-v2.zip\"" {
		t.Fatalf("status=%d headers=%v", w.Code, w.Header())
	}
	if stub.calls[0].query != "organization_id=org-1" {
		t.Fatalf("query=%s", stub.calls[0].query)
	}
	stub.digest = "sha256:deadbeef"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, skillRequest("GET", "/api/admin/skills/"+id+"/versions/2/artifact", nil, "", ""))
	if w.Code != 502 || strings.Contains(w.Body.String(), data) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestSkillConsoleBoundaryCallsRegistryWithServiceTokenAndTrustedScope(t *testing.T) {
	const token = "local-skill-registry-token-000000000000"
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cookie") != "" || r.Header.Get(principal.HeaderUserID) != "" {
			t.Errorf("unsafe Registry headers: %v", r.Header)
		}
		if r.URL.Path != "/internal/skills" || r.URL.Query().Get("organization_id") != "org-1" || r.URL.Query().Has("actor_id") {
			t.Errorf("Registry URL=%s", r.URL)
		}
		_, _ = io.WriteString(w, `{"items":[],"next_after_id":null}`)
	}))
	defer registry.Close()
	client, err := upstream.NewRegistryClient(registry.URL, token, registry.Client())
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(Config{}, Dependencies{Backend: newBackendStub(), Registry: client,
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	r := skillRequest("GET", "/api/admin/skills", nil, "", "")
	r.Header.Set("Cookie", "session=browser-secret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"items":[]`) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
