package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
)

const maximumSkillUpload = 8 << 20

var skillIDPattern = regexp.MustCompile(`^skill_[0-9a-f]{32}$`)

type skillVersion struct {
	SkillID             string `json:"skill_id"`
	Version             int64  `json:"version"`
	Name                string `json:"name"`
	Description         string `json:"description"`
	ArtifactDigest      string `json:"artifact_digest"`
	ContentDigest       string `json:"content_digest"`
	ArtifactSize        int64  `json:"artifact_size"`
	UnpackedSize        int64  `json:"unpacked_size"`
	PackageRulesVersion int    `json:"package_rules_version"`
}

type skillSummary struct {
	SkillID             string `json:"skill_id"`
	Name                string `json:"name"`
	CurrentVersion      int64  `json:"current_version"`
	Description         string `json:"description"`
	ArtifactDigest      string `json:"artifact_digest"`
	ContentDigest       string `json:"content_digest"`
	ArtifactSize        int64  `json:"artifact_size"`
	UnpackedSize        int64  `json:"unpacked_size"`
	PackageRulesVersion int    `json:"package_rules_version"`
}

func (h *handler) registerSkillRoutes() {
	h.mux.HandleFunc("POST /api/admin/skill-sources/search", h.withPrincipal(h.searchSkillSources))
	h.mux.HandleFunc("POST /api/admin/skill-sources/preview", h.withPrincipal(h.previewSkillSource))
	h.mux.HandleFunc("POST /api/admin/skill-sources/promote", h.withPrincipal(h.promoteSkillSource))
	h.mux.HandleFunc("GET /api/admin/skills", h.withPrincipal(h.listSkills))
	h.mux.HandleFunc("POST /api/admin/skills", h.withPrincipal(h.publishSkill))
	h.mux.HandleFunc("GET /api/admin/skills/{skill_id}/versions", h.withPrincipal(h.listSkillVersions))
	h.mux.HandleFunc("POST /api/admin/skills/{skill_id}/versions", h.withPrincipal(h.publishSkillVersion))
	h.mux.HandleFunc("GET /api/admin/skills/{skill_id}/versions/{version}/artifact", h.withPrincipal(h.downloadSkillVersion))
}

func skillQuery(w http.ResponseWriter, r *http.Request, cursor string) (url.Values, bool) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Skill query is invalid")
		return nil, false
	}
	for key, values := range query {
		if key != cursor && key != "limit" || len(values) != 1 || len(values[0]) > maximumListCursorBytes {
			writeError(w, http.StatusBadRequest, "invalid_request", "Skill query is invalid")
			return nil, false
		}
	}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			writeError(w, http.StatusBadRequest, "invalid_request", "Skill page size is invalid")
			return nil, false
		}
	}
	if cursor == "after_version" && query.Has(cursor) {
		if version, err := strconv.ParseInt(query.Get(cursor), 10, 64); err != nil || version < 1 {
			writeError(w, http.StatusBadRequest, "invalid_request", "Skill version cursor is invalid")
			return nil, false
		}
	}
	return query, true
}

func validSkillPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("skill_id")
	if !skillIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid_request", "Skill ID is invalid")
		return "", false
	}
	return id, true
}

func (h *handler) listSkills(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	query, ok := skillQuery(w, r, "after_id")
	if !ok {
		return
	}
	query.Set("organization_id", actor.OrganizationID)
	result, ok := h.skillCall(w, r, http.MethodGet, "/internal/skills", query.Encode(), "", nil)
	if !ok {
		return
	}
	var page struct {
		Items       []skillSummary `json:"items"`
		NextAfterID *string        `json:"next_after_id"`
	}
	if json.Unmarshal(result, &page) != nil || page.Items == nil {
		writeError(w, http.StatusBadGateway, "invalid_upstream_response", "Skill inventory response is invalid")
		return
	}
	for _, item := range page.Items {
		if !skillIDPattern.MatchString(item.SkillID) || item.Name == "" || item.CurrentVersion < 1 || item.PackageRulesVersion < 1 {
			writeError(w, http.StatusBadGateway, "invalid_upstream_response", "Skill inventory response is invalid")
			return
		}
	}
	if page.NextAfterID != nil && *page.NextAfterID == "" {
		page.NextAfterID = nil
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *handler) listSkillVersions(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	id, ok := validSkillPath(w, r)
	if !ok {
		return
	}
	query, ok := skillQuery(w, r, "after_version")
	if !ok {
		return
	}
	query.Set("organization_id", actor.OrganizationID)
	result, ok := h.skillCall(w, r, http.MethodGet, "/internal/skills/"+id+"/versions", query.Encode(), "", nil)
	if !ok {
		return
	}
	var page struct {
		Items            []skillVersion `json:"items"`
		NextAfterVersion *int64         `json:"next_after_version"`
	}
	if json.Unmarshal(result, &page) != nil || page.Items == nil {
		writeError(w, http.StatusBadGateway, "invalid_upstream_response", "Skill version response is invalid")
		return
	}
	for _, item := range page.Items {
		if item.SkillID != id || item.Version < 1 || item.Name == "" || item.PackageRulesVersion < 1 {
			writeError(w, http.StatusBadGateway, "invalid_upstream_response", "Skill version response is invalid")
			return
		}
	}
	if page.NextAfterVersion != nil && *page.NextAfterVersion == 0 {
		page.NextAfterVersion = nil
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *handler) publishSkill(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	h.publishSkillTo(w, r, actor, "")
}

func (h *handler) publishSkillVersion(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	id, ok := validSkillPath(w, r)
	if !ok {
		return
	}
	h.publishSkillTo(w, r, actor, id)
}

func (h *handler) publishSkillTo(w http.ResponseWriter, r *http.Request, actor principal.Principal, id string) {
	requestID, ok := commandRequestID(w, r, actor.OrganizationID, "skill")
	if !ok {
		return
	}
	select {
	case h.skillUploads <- struct{}{}:
		defer func() { <-h.skillUploads }()
	default:
		writeError(w, http.StatusTooManyRequests, "busy", "Skill upload capacity is exhausted")
		return
	}
	archive, expected, ok := browserSkillUpload(w, r, id != "")
	if !ok {
		return
	}
	metadata := map[string]any{"request_id": requestID, "organization_id": actor.OrganizationID, "actor_id": actor.UserID}
	if id != "" {
		metadata["expected_version"] = expected
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormField("metadata")
	if err == nil {
		err = json.NewEncoder(part).Encode(metadata)
	}
	if err == nil {
		part, err = writer.CreateFormFile("artifact", "skill.zip")
	}
	if err == nil {
		_, err = part.Write(archive)
	}
	if err == nil {
		err = writer.Close()
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encoding_failed", "Skill upload could not be encoded")
		return
	}
	path := "/internal/skills"
	if id != "" {
		path += "/" + id + "/versions"
	}
	result, ok := h.skillCall(w, r, http.MethodPost, path, "", writer.FormDataContentType(), buffer.Bytes())
	if !ok {
		return
	}
	var version skillVersion
	if json.Unmarshal(result, &version) != nil || !skillIDPattern.MatchString(version.SkillID) || id != "" && version.SkillID != id || version.Version < 1 || version.Name == "" || version.PackageRulesVersion < 1 {
		writeError(w, http.StatusBadGateway, "invalid_upstream_response", "Skill publication response is invalid")
		return
	}
	writeJSON(w, http.StatusCreated, version)
}

func browserSkillUpload(w http.ResponseWriter, r *http.Request, revision bool) ([]byte, int64, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maximumSkillUpload+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, 400, "invalid_request", "Multipart Skill upload is required")
		return nil, 0, false
	}
	var archive []byte
	var expected int64
	seenVersion := false
	for count := 0; ; count++ {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil || count >= 2 {
			writeError(w, 400, "invalid_request", "Skill upload contains invalid parts")
			return nil, 0, false
		}
		switch part.FormName() {
		case "artifact":
			if archive != nil || part.FileName() == "" {
				writeError(w, 400, "invalid_request", "One ZIP artifact is required")
				return nil, 0, false
			}
			archive, err = io.ReadAll(io.LimitReader(part, maximumSkillUpload+1))
			if err != nil || len(archive) > maximumSkillUpload {
				writeError(w, 413, "limit_exceeded", "Skill ZIP exceeds 8 MiB")
				return nil, 0, false
			}
		case "expected_version":
			if !revision || seenVersion || part.FileName() != "" {
				writeError(w, 400, "invalid_request", "Skill version field is invalid")
				return nil, 0, false
			}
			value, readErr := io.ReadAll(io.LimitReader(part, 32))
			expected, err = strconv.ParseInt(string(value), 10, 64)
			if readErr != nil || err != nil || expected < 1 {
				writeError(w, 400, "invalid_request", "Expected version is invalid")
				return nil, 0, false
			}
			seenVersion = true
		default:
			writeError(w, 400, "invalid_request", "Unexpected Skill upload field")
			return nil, 0, false
		}
		_ = part.Close()
	}
	if len(archive) == 0 || revision && !seenVersion {
		writeError(w, 400, "invalid_request", "Skill ZIP and expected version are required")
		return nil, 0, false
	}
	return archive, expected, true
}

func (h *handler) skillCall(w http.ResponseWriter, r *http.Request, method, path, query, contentType string, body []byte) ([]byte, bool) {
	expectedStatus := http.StatusOK
	if method == http.MethodPost {
		expectedStatus = http.StatusCreated
	}
	data, _, ok := h.skillResponse(w, r, method, path, query, contentType, body, expectedStatus, maximumSkillUpload)
	return data, ok
}

func (h *handler) skillResponse(w http.ResponseWriter, r *http.Request, method, path, query, contentType string, body []byte, expectedStatus, maximum int) ([]byte, http.Header, bool) {
	if h.registry == nil {
		writeError(w, 503, "dependency_unavailable", "Skill Registry is not configured")
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.registry.Do(ctx, method, path, query, contentType, body)
	if err != nil || result == nil || result.Body == nil {
		writeError(w, 503, "dependency_unavailable", "Skill Registry is unavailable")
		return nil, nil, false
	}
	defer func() { _ = result.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(result.Body, int64(maximum)+1))
	if err != nil || len(data) > maximum {
		writeError(w, 502, "invalid_upstream_response", "Skill Registry response is invalid")
		return nil, nil, false
	}
	if result.StatusCode != expectedStatus {
		var failure struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &failure) != nil || failure.Error.Code == "" {
			writeError(w, 502, "invalid_upstream_response", "Skill Registry response is invalid")
			return nil, nil, false
		}
		if result.StatusCode == 401 {
			writeError(w, 503, "dependency_unavailable", "Skill Registry authentication failed")
			return nil, nil, false
		}
		allowed := map[int]map[string]bool{
			400: {"invalid_request": true, "invalid_package": true},
			404: {"not_found": true},
			409: {"name_conflict": true, "request_conflict": true, "revision_conflict": true, "content_changed": true},
			413: {"limit_exceeded": true},
			429: {"busy": true},
			502: {"source_invalid": true},
			503: {"temporarily_unavailable": true, "source_unavailable": true},
		}
		if !allowed[result.StatusCode][failure.Error.Code] || len(failure.Error.Message) > 512 || strings.ContainsAny(failure.Error.Message, "\r\n\x00") {
			writeError(w, 502, "invalid_upstream_response", "Skill Registry response is invalid")
			return nil, nil, false
		}
		writeError(w, result.StatusCode, failure.Error.Code, failure.Error.Message)
		return nil, nil, false
	}
	return data, result.Header, true
}

func (h *handler) downloadSkillVersion(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	id, ok := validSkillPath(w, r)
	if !ok {
		return
	}
	version, err := strconv.ParseInt(r.PathValue("version"), 10, 64)
	if err != nil || version < 1 || r.URL.RawQuery != "" {
		writeError(w, 400, "invalid_request", "Skill version is invalid")
		return
	}
	if h.registry == nil {
		writeError(w, 503, "dependency_unavailable", "Skill Registry is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.requestTimeout)
	defer cancel()
	query := url.Values{"organization_id": {actor.OrganizationID}}.Encode()
	upstream, err := h.registry.Do(ctx, "GET", fmt.Sprintf("/internal/skills/%s/versions/%d/artifact", id, version), query, "", nil)
	if err != nil || upstream == nil || upstream.Body == nil {
		writeError(w, 503, "dependency_unavailable", "Skill Registry is unavailable")
		return
	}
	defer func() { _ = upstream.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(upstream.Body, maximumSkillUpload+1))
	if err != nil || len(data) > maximumSkillUpload {
		writeError(w, 502, "invalid_upstream_response", "Skill artifact response is invalid")
		return
	}
	if upstream.StatusCode != 200 {
		var failure struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &failure) != nil || failure.Error.Code == "" {
			writeError(w, 502, "invalid_upstream_response", "Skill Registry response is invalid")
			return
		}
		if upstream.StatusCode == 404 {
			writeError(w, 404, "not_found", "Skill version was not found")
			return
		}
		writeError(w, 503, "dependency_unavailable", "Skill Registry is unavailable")
		return
	}
	digest := upstream.Header.Get("X-Antnest-Artifact-Digest")
	actual := sha256.Sum256(data)
	if digest != "sha256:"+hex.EncodeToString(actual[:]) || len(data) == 0 || !strings.HasPrefix(upstream.Header.Get("Content-Type"), "application/zip") {
		writeError(w, 502, "invalid_upstream_response", "Skill artifact response is invalid")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s-v%d.zip\"", id, version))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Antnest-Artifact-Digest", digest)
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
