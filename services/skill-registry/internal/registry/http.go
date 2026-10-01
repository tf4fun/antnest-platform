package registry

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/telemetry"
)

type Handler struct {
	service   *Service
	discovery *Discovery
	token     string
	ready     func(context.Context) error
	uploading chan struct{}
	download  chan struct{}
	mux       *http.ServeMux
	http      http.Handler
}

func NewHandler(service *Service, token string, ready func(context.Context) error, discovery ...*Discovery) *Handler {
	h := &Handler{service: service, token: token, ready: ready,
		uploading: make(chan struct{}, 2), download: make(chan struct{}, 4), mux: http.NewServeMux()}
	if len(discovery) != 0 {
		h.discovery = discovery[0]
	}
	h.mux.HandleFunc("GET /status", h.status)
	h.mux.HandleFunc("POST /internal/skills", h.auth(h.create))
	h.mux.HandleFunc("POST /internal/skills/{skill_id}/versions", h.auth(h.appendVersion))
	h.mux.HandleFunc("GET /internal/skills", h.auth(h.list))
	h.mux.HandleFunc("GET /internal/skills/{skill_id}/versions", h.auth(h.versions))
	h.mux.HandleFunc("POST /internal/skill-versions/resolve", h.auth(h.resolve))
	h.mux.HandleFunc("GET /internal/skills/{skill_id}/versions/{version}/artifact", h.auth(h.artifact))
	h.mux.HandleFunc("PUT /internal/skill-projections", h.auth(h.updateProjection))
	h.mux.HandleFunc("POST /internal/skill-discovery/search", h.auth(h.searchSkills))
	h.mux.HandleFunc("POST /internal/skill-discovery/load", h.auth(h.loadSkill))
	h.mux.HandleFunc("POST /internal/skill-projections/promote", h.auth(h.promoteSkill))
	h.http = telemetry.HTTPHandler(h.mux)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.http.ServeHTTP(w, r) }

func (h *Handler) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values("Authorization")
		if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte("Bearer "+h.token)) != 1 {
			writeError(w, failure("unauthorized", "service authentication required"))
			return
		}
		next(w, r)
	}
}

func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	if h.ready != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := h.ready(ctx); err != nil {
			writeError(w, failure("temporarily_unavailable", "Registry is not ready"))
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func admission(slot chan struct{}, w http.ResponseWriter) (func(), bool) {
	select {
	case slot <- struct{}{}:
		return func() { <-slot }, true
	default:
		writeError(w, failure("busy", "Registry request capacity is exhausted"))
		return nil, false
	}
}

type publicationMetadata struct {
	RequestID       string `json:"request_id"`
	OrganizationID  string `json:"organization_id"`
	ActorID         string `json:"actor_id"`
	ExpectedVersion *int64 `json:"expected_version,omitempty"`
}

func decodeOne(data []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var next any
	if err := decoder.Decode(&next); err != io.EOF {
		return failure("invalid_request", "JSON must contain one object")
	}
	return nil
}

func readUpload(w http.ResponseWriter, r *http.Request) (publicationMetadata, []byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxArtifactBytes+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		return publicationMetadata{}, nil, failure("invalid_request", "multipart upload required")
	}
	var metadata []byte
	var archive []byte
	parts := 0
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return publicationMetadata{}, nil, failure("limit_exceeded", "upload exceeds transport limit or is malformed")
		}
		parts++
		if parts > 2 {
			_ = part.Close()
			return publicationMetadata{}, nil, failure("invalid_request", "unexpected upload part")
		}
		var limit int64
		switch part.FormName() {
		case "metadata":
			if metadata != nil || part.FileName() != "" {
				_ = part.Close()
				return publicationMetadata{}, nil, failure("invalid_request", "duplicate or invalid metadata part")
			}
			limit = 4 << 10
		case "artifact":
			if archive != nil {
				_ = part.Close()
				return publicationMetadata{}, nil, failure("invalid_request", "duplicate artifact part")
			}
			limit = MaxArtifactBytes
		default:
			_ = part.Close()
			return publicationMetadata{}, nil, failure("invalid_request", "unexpected upload part")
		}
		value, readErr := io.ReadAll(io.LimitReader(part, limit+1))
		closeErr := part.Close()
		if readErr != nil || closeErr != nil {
			return publicationMetadata{}, nil, failure("invalid_request", "malformed upload part")
		}
		if int64(len(value)) > limit {
			return publicationMetadata{}, nil, failure("limit_exceeded", "upload part exceeds size limit")
		}
		if part.FormName() == "metadata" {
			metadata = value
		} else {
			archive = value
		}
	}
	if len(metadata) == 0 || len(archive) == 0 {
		return publicationMetadata{}, nil, failure("invalid_request", "metadata and artifact are required")
	}
	var input publicationMetadata
	if err := decodeOne(metadata, &input); err != nil {
		return publicationMetadata{}, nil, failure("invalid_request", "invalid publication metadata")
	}
	return input, archive, nil
}

func (h *Handler) publish(w http.ResponseWriter, r *http.Request, appendTo string) {
	release, ok := admission(h.uploading, w)
	if !ok {
		return
	}
	defer release()
	meta, archive, err := readUpload(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	if appendTo == "" && meta.ExpectedVersion != nil || appendTo != "" && meta.ExpectedVersion == nil {
		writeError(w, failure("invalid_request", "expected_version is required only for append"))
		return
	}
	input := PublishInput{RequestID: meta.RequestID, OrganizationID: meta.OrganizationID,
		ActorID: meta.ActorID, SkillID: appendTo, Artifact: archive}
	if meta.ExpectedVersion != nil {
		input.ExpectedVersion = *meta.ExpectedVersion
	}
	value, err := h.service.Publish(r.Context(), input)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) { h.publish(w, r, "") }

func (h *Handler) appendVersion(w http.ResponseWriter, r *http.Request) {
	h.publish(w, r, r.PathValue("skill_id"))
}

func queryLimit(r *http.Request) (int, error) {
	value := r.URL.Query().Get("limit")
	if value == "" {
		return 0, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil {
		return 0, failure("invalid_request", "invalid page limit")
	}
	return limit, nil
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	limit, err := queryLimit(r)
	if err != nil {
		writeError(w, err)
		return
	}
	page, err := h.service.List(r.Context(), r.URL.Query().Get("organization_id"), r.URL.Query().Get("after_id"), limit)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) versions(w http.ResponseWriter, r *http.Request) {
	limit, err := queryLimit(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var after int64
	if raw := r.URL.Query().Get("after_version"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeError(w, failure("invalid_request", "invalid version cursor"))
			return
		}
	}
	page, err := h.service.Versions(r.Context(), r.URL.Query().Get("organization_id"), r.PathValue("skill_id"), after, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) resolve(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, failure("limit_exceeded", "resolve request exceeds limit"))
		return
	}
	var input struct {
		OrganizationID string      `json:"organization_id"`
		Refs           []Reference `json:"refs"`
	}
	if err := decodeOne(data, &input); err != nil {
		writeError(w, failure("invalid_request", "invalid resolve request"))
		return
	}
	items, err := h.service.Resolve(r.Context(), input.OrganizationID, input.Refs)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]Version{"items": items})
}

func (h *Handler) artifact(w http.ResponseWriter, r *http.Request) {
	release, ok := admission(h.download, w)
	if !ok {
		return
	}
	defer release()
	version, err := strconv.ParseInt(r.PathValue("version"), 10, 64)
	if err != nil {
		writeError(w, failure("invalid_request", "invalid Skill version"))
		return
	}
	value, archive, err := h.service.Artifact(r.Context(), r.URL.Query().Get("organization_id"), r.PathValue("skill_id"), version)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Length", strconv.Itoa(len(archive)))
	w.Header().Set("ETag", "\""+value.ArtifactDigest+"\"")
	w.Header().Set("X-Antnest-Artifact-Digest", value.ArtifactDigest)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(archive)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, err error) {
	code := Code(err)
	status := http.StatusServiceUnavailable
	switch code {
	case "invalid_request", "invalid_package":
		status = http.StatusBadRequest
	case "unauthorized":
		status = http.StatusUnauthorized
	case "not_found":
		status = http.StatusNotFound
	case "name_conflict", "request_conflict", "revision_conflict", "content_changed":
		status = http.StatusConflict
	case "limit_exceeded":
		status = http.StatusRequestEntityTooLarge
	case "busy":
		status = http.StatusTooManyRequests
	case "source_invalid":
		status = http.StatusBadGateway
	}
	message := "Registry temporarily unavailable"
	var typed *Error
	if errors.As(err, &typed) {
		message = typed.Text
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": strings.TrimSpace(message)}})
}
