package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
)

const maximumSourceSequence int64 = 9007199254740991

var sourceAgentPattern = regexp.MustCompile(`^agent_[0-9a-f]{32}$`)
var sourceNamePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var sourceDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type agentSkillSourceRef struct {
	Kind     string `json:"kind"`
	AgentID  string `json:"agent_id"`
	Name     string `json:"name"`
	Sequence int64  `json:"sequence"`
}

type skillSourceSelection struct {
	SkillRef       agentSkillSourceRef `json:"skill_ref"`
	ExpectedDigest string              `json:"expected_digest"`
}

func validAgentSkillSource(ref agentSkillSourceRef) bool {
	return ref.Kind == "agent" && sourceAgentPattern.MatchString(ref.AgentID) &&
		len(ref.Name) <= 64 && sourceNamePattern.MatchString(ref.Name) &&
		ref.Sequence >= 1 && ref.Sequence <= maximumSourceSequence
}

func readSkillSourceRequest(w http.ResponseWriter, r *http.Request, out any) (map[string]json.RawMessage, bool) {
	if r.URL.RawQuery != "" {
		writeError(w, 400, "invalid_request", "Skill source queries are not accepted")
		return nil, false
	}
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		writeError(w, 415, "invalid_request", "Content-Type must be application/json")
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, 400, "invalid_request", "Skill source request exceeds 4 KiB")
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var extra json.RawMessage
	var fields map[string]json.RawMessage
	if decoder.Decode(out) != nil || decoder.Decode(&extra) != io.EOF || json.Unmarshal(data, &fields) != nil || fields == nil {
		writeError(w, 400, "invalid_request", "Skill source request is invalid")
		return nil, false
	}
	return fields, true
}

func (h *handler) searchSkillSources(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	var input struct {
		Query string `json:"query"`
		Limit int    `json:"limit,omitempty"`
	}
	fields, ok := readSkillSourceRequest(w, r, &input)
	if !ok {
		return
	}
	input.Query = strings.TrimSpace(input.Query)
	_, hasLimit := fields["limit"]
	if len(input.Query) < 1 || len(input.Query) > 256 || !utf8.ValidString(input.Query) || strings.ContainsRune(input.Query, 0) ||
		input.Limit < 0 || input.Limit > 50 || hasLimit && input.Limit == 0 {
		writeError(w, 400, "invalid_request", "Skill source search is invalid")
		return
	}
	if !hasLimit {
		input.Limit = 20
	}
	body, err := json.Marshal(map[string]any{"organization_id": actor.OrganizationID, "actor_id": actor.UserID, "query": input.Query, "limit": input.Limit})
	if err != nil {
		writeError(w, 500, "encoding_failed", "Skill search could not be encoded")
		return
	}
	data, _, ok := h.skillResponse(w, r, http.MethodPost, "/internal/skill-discovery/search", "", "application/json", body, 200, 64<<10)
	if !ok {
		return
	}
	type sourceItem struct {
		SkillRef struct {
			Kind     string `json:"kind"`
			AgentID  string `json:"agent_id,omitempty"`
			Name     string `json:"name,omitempty"`
			Sequence int64  `json:"sequence,omitempty"`
			SkillID  string `json:"skill_id,omitempty"`
			Version  int64  `json:"version,omitempty"`
		} `json:"skill_ref"`
		Name          string `json:"name"`
		Description   string `json:"description"`
		ContentDigest string `json:"content_digest"`
	}
	var page struct {
		Items []sourceItem `json:"items"`
	}
	if json.Unmarshal(data, &page) != nil || page.Items == nil || len(page.Items) > input.Limit {
		writeError(w, 502, "invalid_upstream_response", "Skill source search response is invalid")
		return
	}
	items := make([]sourceItem, 0, len(page.Items))
	seen := make(map[agentSkillSourceRef]bool)
	for _, item := range page.Items {
		ref := item.SkillRef
		valid := len(item.Name) <= 64 && sourceNamePattern.MatchString(item.Name) && len(item.Description) >= 1 && len(item.Description) <= 512 &&
			utf8.ValidString(item.Description) && strings.TrimSpace(item.Description) == item.Description && !strings.ContainsRune(item.Description, 0) && sourceDigestPattern.MatchString(item.ContentDigest)
		switch ref.Kind {
		case "agent":
			selected := agentSkillSourceRef{Kind: ref.Kind, AgentID: ref.AgentID, Name: ref.Name, Sequence: ref.Sequence}
			valid = valid && validAgentSkillSource(selected) && item.Name == ref.Name && ref.SkillID == "" && ref.Version == 0 && !seen[selected]
			seen[selected] = true
		case "registry":
			valid = valid && skillIDPattern.MatchString(ref.SkillID) && ref.Version >= 1 && ref.Version <= maximumSourceSequence && ref.AgentID == "" && ref.Name == "" && ref.Sequence == 0
		default:
			valid = false
		}
		if !valid {
			writeError(w, 502, "invalid_upstream_response", "Skill source search response is invalid")
			return
		}
		if ref.Kind == "agent" {
			items = append(items, item)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, struct {
		Items []sourceItem `json:"items"`
	}{items})
}

func (h *handler) admitSkillSource(w http.ResponseWriter) (func(), bool) {
	select {
	case h.skillUploads <- struct{}{}:
		return func() { <-h.skillUploads }, true
	default:
		writeError(w, 429, "busy", "Skill package capacity is exhausted")
		return nil, false
	}
}

func (h *handler) previewSkillSource(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	var input skillSourceSelection
	if _, ok := readSkillSourceRequest(w, r, &input); !ok {
		return
	}
	if !validAgentSkillSource(input.SkillRef) || !sourceDigestPattern.MatchString(input.ExpectedDigest) {
		writeError(w, 400, "invalid_request", "Selected Skill source is invalid")
		return
	}
	release, ok := h.admitSkillSource(w)
	if !ok {
		return
	}
	defer release()
	body, err := json.Marshal(map[string]any{"organization_id": actor.OrganizationID, "actor_id": actor.UserID, "skill_ref": input.SkillRef, "expected_digest": input.ExpectedDigest})
	if err != nil {
		writeError(w, 500, "encoding_failed", "Skill preview could not be encoded")
		return
	}
	data, headers, ok := h.skillResponse(w, r, http.MethodPost, "/internal/skill-discovery/load", "", "application/json", body, 200, maximumSkillUpload)
	if !ok {
		return
	}
	media, _, _ := mime.ParseMediaType(headers.Get("Content-Type"))
	preview, err := inspectSourcePackage(r.Context(), input, data, headers.Get("X-Antnest-Artifact-Digest"), headers.Get("X-Antnest-Content-Digest"))
	if media != "application/zip" || err != nil {
		writeError(w, 502, "invalid_upstream_response", "Skill source package response is invalid")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, preview)
}

func (h *handler) promoteSkillSource(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	var input struct {
		SkillRef        agentSkillSourceRef `json:"skill_ref"`
		ExpectedDigest  string              `json:"expected_digest"`
		SkillID         string              `json:"skill_id,omitempty"`
		ExpectedVersion int64               `json:"expected_version,omitempty"`
	}
	fields, ok := readSkillSourceRequest(w, r, &input)
	if !ok {
		return
	}
	_, hasTarget := fields["skill_id"]
	_, hasVersion := fields["expected_version"]
	if !validAgentSkillSource(input.SkillRef) || !sourceDigestPattern.MatchString(input.ExpectedDigest) || hasTarget != hasVersion ||
		hasTarget && (!skillIDPattern.MatchString(input.SkillID) || input.ExpectedVersion < 1 || input.ExpectedVersion > maximumSourceSequence) {
		writeError(w, 400, "invalid_request", "Selected Skill source or publication target is invalid")
		return
	}
	requestID, ok := commandRequestID(w, r, actor.OrganizationID, "skill")
	if !ok {
		return
	}
	release, ok := h.admitSkillSource(w)
	if !ok {
		return
	}
	defer release()
	metadata := map[string]any{"request_id": requestID, "organization_id": actor.OrganizationID, "actor_id": actor.UserID, "skill_ref": input.SkillRef, "expected_digest": input.ExpectedDigest}
	if hasTarget {
		metadata["skill_id"] = input.SkillID
		metadata["expected_version"] = input.ExpectedVersion
	}
	body, err := json.Marshal(metadata)
	if err != nil {
		writeError(w, 500, "encoding_failed", "Skill promotion could not be encoded")
		return
	}
	data, _, ok := h.skillResponse(w, r, http.MethodPost, "/internal/skill-projections/promote", "", "application/json", body, 201, 4<<10)
	if !ok {
		return
	}
	var version skillVersion
	if json.Unmarshal(data, &version) != nil || !skillIDPattern.MatchString(version.SkillID) || version.Name != input.SkillRef.Name ||
		version.ContentDigest != input.ExpectedDigest || !sourceDigestPattern.MatchString(version.ArtifactDigest) || version.Version < 1 || version.Version > maximumSourceSequence ||
		version.PackageRulesVersion != 1 || version.ArtifactSize < 1 || version.ArtifactSize > maximumSkillUpload || version.UnpackedSize < 1 || version.UnpackedSize > 32<<20 ||
		len(version.Description) < 1 || len(version.Description) > 512 || !hasTarget && version.Version != 1 || hasTarget && (version.SkillID != input.SkillID || version.Version != input.ExpectedVersion+1) {
		writeError(w, 502, "invalid_upstream_response", "Skill promotion response is invalid")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 201, version)
}
