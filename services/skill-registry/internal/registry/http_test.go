package registry

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

const testToken = "0123456789abcdef0123456789abcdef"

func publishRequest(t *testing.T, metadata any, archive []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormField("metadata")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(part).Encode(metadata); err != nil {
		t.Fatal(err)
	}
	part, err = writer.CreateFormFile("artifact", "skill.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(archive); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/internal/skills", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+testToken)
	return request
}

func TestHTTPRequiresTokenAndPublishesBoundedPackage(t *testing.T) {
	handler := NewHandler(NewService(&memoryStore{}), testToken, nil)
	unauthorized := httptest.NewRequest(http.MethodGet, "/internal/skills?organization_id="+testOrg, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, unauthorized)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", response.Code)
	}

	archive := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\n")
	request := publishRequest(t, map[string]any{"request_id": "r1", "organization_id": testOrg, "actor_id": testActor}, archive)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("publish status=%d body=%s", response.Code, response.Body.String())
	}
	var published Version
	if err := json.Unmarshal(response.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	if published.Name != "code-review" || published.Version != 1 || published.PackageRulesVersion != 1 {
		t.Fatalf("bad response: %#v", published)
	}
}

func TestHTTPRejectsUnknownMetadataField(t *testing.T) {
	handler := NewHandler(NewService(&memoryStore{}), testToken, nil)
	request := publishRequest(t, map[string]any{"request_id": "r1", "organization_id": testOrg, "actor_id": testActor, "admin": true},
		skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\n"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !bytes.Contains(response.Body.Bytes(), []byte("invalid_request")) {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
}

func TestHTTPListsResolvesAndDownloadsOnlyWithinOrganization(t *testing.T) {
	store := &memoryStore{}
	handler := NewHandler(NewService(store), testToken, nil)
	archive := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\n")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, publishRequest(t,
		map[string]any{"request_id": "r2", "organization_id": testOrg, "actor_id": testActor}, archive))
	if response.Code != http.StatusCreated {
		t.Fatalf("publish: %d %s", response.Code, response.Body.String())
	}
	var version Version
	if err := json.Unmarshal(response.Body.Bytes(), &version); err != nil {
		t.Fatal(err)
	}
	get := func(target string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	listed := get("/internal/skills?organization_id=" + testOrg)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(version.ContentDigest)) {
		t.Fatalf("current metadata missing from list: %d %s", listed.Code, listed.Body.String())
	}
	target := "/internal/skills/" + version.SkillID + "/versions/1/artifact?organization_id="
	download := get(target + testOrg)
	if download.Code != http.StatusOK || !bytes.Equal(download.Body.Bytes(), archive) ||
		download.Header().Get("X-Antnest-Artifact-Digest") != version.ArtifactDigest {
		t.Fatalf("bad artifact: %d headers=%v", download.Code, download.Header())
	}
	if other := get(target + testOther); other.Code != http.StatusNotFound {
		t.Fatalf("cross-org artifact leaked: %d", other.Code)
	}
}
