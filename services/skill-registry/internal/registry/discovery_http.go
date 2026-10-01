package registry

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
)

func (h *Handler) readDiscovery(w http.ResponseWriter, r *http.Request, out any) (map[string]json.RawMessage, bool) {
	if h.discovery == nil {
		writeError(w, failure("temporarily_unavailable", "Skill discovery is not configured"))
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, failure("limit_exceeded", "discovery request exceeds 4 KiB"))
		return nil, false
	}
	if err := decodeOne(data, out); err != nil {
		writeError(w, failure("invalid_request", "invalid discovery request"))
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		writeError(w, failure("invalid_request", "JSON object required"))
		return nil, false
	}
	return fields, true
}
func (h *Handler) updateProjection(w http.ResponseWriter, r *http.Request) {
	var in Projection
	fields, ok := h.readDiscovery(w, r, &in)
	if !ok {
		return
	}
	if raw, ok := fields["active"]; !ok || string(raw) != "true" && string(raw) != "false" {
		writeError(w, failure("invalid_request", "active is required"))
		return
	}
	out, err := h.discovery.Update(r.Context(), in)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
func (h *Handler) searchSkills(w http.ResponseWriter, r *http.Request) {
	release, ok := admission(h.download, w)
	if !ok {
		return
	}
	defer release()
	var in SearchInput
	fields, ok := h.readDiscovery(w, r, &in)
	if !ok {
		return
	}
	if _, explicit := fields["limit"]; explicit && in.Limit < 1 {
		writeError(w, failure("invalid_request", "limit must be 1–50"))
		return
	}
	if _, explicit := fields["requesting_agent_id"]; explicit && !agentID.MatchString(in.RequestingAgentID) {
		writeError(w, failure("invalid_request", "invalid requesting Agent identity"))
		return
	}
	items, err := h.discovery.Search(r.Context(), in)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string][]DiscoveryItem{"items": items})
}
func (h *Handler) loadSkill(w http.ResponseWriter, r *http.Request) {
	release, ok := admission(h.download, w)
	if !ok {
		return
	}
	defer release()
	var in LoadInput
	if _, ok := h.readDiscovery(w, r, &in); !ok {
		return
	}
	out, err := h.discovery.Load(r.Context(), in)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Length", strconv.Itoa(len(out.Package.Artifact)))
	w.Header().Set("ETag", "\""+out.Package.ArtifactDigest+"\"")
	w.Header().Set("X-Antnest-Artifact-Digest", out.Package.ArtifactDigest)
	w.Header().Set("X-Antnest-Content-Digest", out.Package.ContentDigest)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out.Package.Artifact)
}
func (h *Handler) promoteSkill(w http.ResponseWriter, r *http.Request) {
	release, ok := admission(h.uploading, w)
	if !ok {
		return
	}
	defer release()
	var in PromoteInput
	fields, ok := h.readDiscovery(w, r, &in)
	if !ok {
		return
	}
	_, hasSkill := fields["skill_id"]
	_, hasVersion := fields["expected_version"]
	if hasSkill != hasVersion || hasSkill && (in.SkillID == "" || in.ExpectedVersion < 1) {
		writeError(w, failure("invalid_request", "append requires both Skill and expected version"))
		return
	}
	out, err := h.discovery.Promote(r.Context(), in)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}
