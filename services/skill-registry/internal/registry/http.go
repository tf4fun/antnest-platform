package registry

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/apierror"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/telemetry"
)

type Handler struct {
	service   *Service
	discovery *Discovery
	security  Security
	ready     func(context.Context) error
	uploading chan struct{}
	download  chan struct{}
	mux       *http.ServeMux
	http      http.Handler
}

func NewHandler(service *Service, security Security, ready func(context.Context) error, discovery ...*Discovery) (*Handler, error) {
	if err := security.validate(); err != nil {
		return nil, err
	}
	h := &Handler{service: service, security: security, ready: ready,
		uploading: make(chan struct{}, 2), download: make(chan struct{}, 4), mux: http.NewServeMux()}
	if len(discovery) != 0 {
		h.discovery = discovery[0]
	}
	h.mux.HandleFunc("GET /status", h.status)
	h.mux.HandleFunc("POST /internal/skills", h.auth([]string{"admin-console"}, false, h.create))
	h.mux.HandleFunc("POST /internal/skills/{skill_id}/versions", h.auth([]string{"admin-console"}, false, h.appendVersion))
	h.mux.HandleFunc("GET /internal/skills", h.auth([]string{"admin-console"}, false, h.list))
	h.mux.HandleFunc("GET /internal/skills/{skill_id}/versions", h.auth([]string{"admin-console"}, false, h.versions))
	h.mux.HandleFunc("POST /internal/skill-versions/resolve", h.auth([]string{"agent-controller"}, true, h.resolve))
	h.mux.HandleFunc("GET /internal/skills/{skill_id}/versions/{version}/artifact", h.auth([]string{"admin-console", "runtime-controller"}, false, h.artifact))
	h.mux.HandleFunc("PUT /internal/skill-projections", h.auth([]string{"agent-acp-service"}, true, h.updateProjection))
	h.mux.HandleFunc("POST /internal/skill-discovery/search", h.auth([]string{"admin-console", "agent-acp-service"}, true, h.searchSkills))
	h.mux.HandleFunc("POST /internal/skill-discovery/load", h.auth([]string{"admin-console", "agent-acp-service"}, true, h.loadSkill))
	h.mux.HandleFunc("POST /internal/skill-projections/promote", h.auth([]string{"admin-console"}, true, h.promoteSkill))
	h.http = telemetry.HTTPHandler(&authenticatedMux{mux: h.mux, security: security})
	return h, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.http.ServeHTTP(w, r) }

func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	if h.ready != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := h.ready(ctx); err != nil {
			writeError(w, failure(apierror.TemporarilyUnavailable, "Registry is not ready"))
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
		writeError(w, failure(apierror.Busy, "Registry request capacity is exhausted"))
		return nil, false
	}
}

type publicationMetadata struct {
	RequestID       string `json:"request_id"`
	OrganizationID  string `json:"organization_id"`
	ActorID         string `json:"actor_id"`
	ExpectedVersion *int64 `json:"expected_version,omitempty"`
}

func decodeOne(data []byte, out any) error { return serviceauth.DecodeObject(data, out) }

func readUpload(w http.ResponseWriter, r *http.Request) (publicationMetadata, []byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxArtifactBytes+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "multipart upload required")
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
			return publicationMetadata{}, nil, failure(apierror.LimitExceeded, "upload exceeds transport limit or is malformed")
		}
		parts++
		if parts > 2 {
			_ = part.Close()
			return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "unexpected upload part")
		}
		var limit int64
		switch part.FormName() {
		case "metadata":
			if metadata != nil || part.FileName() != "" {
				_ = part.Close()
				return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "duplicate or invalid metadata part")
			}
			limit = 4 << 10
		case "artifact":
			if archive != nil {
				_ = part.Close()
				return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "duplicate artifact part")
			}
			limit = MaxArtifactBytes
		default:
			_ = part.Close()
			return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "unexpected upload part")
		}
		value, readErr := io.ReadAll(io.LimitReader(part, limit+1))
		closeErr := part.Close()
		if readErr != nil || closeErr != nil {
			return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "malformed upload part")
		}
		if int64(len(value)) > limit {
			return publicationMetadata{}, nil, failure(apierror.LimitExceeded, "upload part exceeds size limit")
		}
		if part.FormName() == "metadata" {
			metadata = value
		} else {
			archive = value
		}
	}
	if len(metadata) == 0 || len(archive) == 0 {
		return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "metadata and artifact are required")
	}
	if metadata, err = normalizeExpectedVersion(metadata, r); err != nil {
		return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "invalid publication metadata")
	}
	var input publicationMetadata
	if err := decodeOne(metadata, &input); err != nil {
		return publicationMetadata{}, nil, failure(apierror.InvalidRequest, "invalid publication metadata")
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
		writeError(w, failure(apierror.InvalidRequest, "expected_version is required only for append"))
		return
	}
	if err := verifiedScope(r, &meta.OrganizationID, &meta.ActorID); err != nil {
		writeError(w, err)
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

func parsePageLimit(value string) (int, error) {
	if value == "" {
		return 0, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit == 0 {
		return 0, failure(apierror.InvalidRequest, "invalid page limit")
	}
	return limit, nil
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	query, err := strictPageQuery(r, "after_id")
	if err != nil {
		writeError(w, err)
		return
	}
	limit, err := parsePageLimit(query.Get("limit"))
	if err != nil {
		writeError(w, err)
		return
	}
	org := query.Get("organization_id")
	if err := verifiedScope(r, &org, nil); err != nil {
		writeError(w, err)
		return
	}
	cursor := query.Get("cursor")
	if cursor == "" {
		cursor = query.Get("after_id")
	}
	if len(cursor) > 4096 {
		writeError(w, failure(apierror.InvalidRequest, "cursor exceeds bound"))
		return
	}
	page, err := h.service.List(r.Context(), org, cursor, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	out := struct {
		Items      []Skill `json:"items"`
		NextCursor *string `json:"next_cursor"`
	}{Items: page.Items}
	if page.NextAfterID != "" {
		out.NextCursor = &page.NextAfterID
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) versions(w http.ResponseWriter, r *http.Request) {
	query, err := strictPageQuery(r, "after_version")
	if err != nil {
		writeError(w, err)
		return
	}
	limit, err := parsePageLimit(query.Get("limit"))
	if err != nil {
		writeError(w, err)
		return
	}
	var after int64
	if raw := query.Get("cursor"); raw != "" {
		if !positiveDecimal.MatchString(raw) {
			writeError(w, failure(apierror.InvalidRequest, "invalid version cursor"))
			return
		}
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeError(w, failure(apierror.InvalidRequest, "invalid version cursor"))
			return
		}
	} else if raw := query.Get("after_version"); raw != "" {
		if parsed, parseErr := strconv.ParseInt(raw, 10, 64); parseErr != nil || parsed < 0 {
			writeError(w, failure(apierror.InvalidRequest, "invalid version cursor"))
			return
		} else {
			after = parsed
		}
	}
	org := query.Get("organization_id")
	if err := verifiedScope(r, &org, nil); err != nil {
		writeError(w, err)
		return
	}
	page, err := h.service.Versions(r.Context(), org, r.PathValue("skill_id"), after, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	out := struct {
		Items      []Version `json:"items"`
		NextCursor *string   `json:"next_cursor"`
	}{Items: page.Items}
	if page.NextAfterVersion != 0 {
		cursor := strconv.FormatInt(page.NextAfterVersion, 10)
		out.NextCursor = &cursor
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) resolve(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, failure(apierror.LimitExceeded, "resolve request exceeds limit"))
		return
	}
	var input struct {
		OrganizationID string      `json:"organization_id"`
		Refs           []Reference `json:"refs"`
	}
	if err := decodeOne(data, &input); err != nil {
		writeError(w, failure(apierror.InvalidRequest, "invalid resolve request"))
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
		writeError(w, failure(apierror.InvalidRequest, "invalid Skill version"))
		return
	}
	org := r.URL.Query().Get("organization_id")
	if err := verifiedScope(r, &org, nil); err != nil {
		writeError(w, err)
		return
	}
	value, archive, err := h.service.Artifact(r.Context(), org, r.PathValue("skill_id"), version)
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

type registryErrorResponse struct {
	Code      string         `json:"code"`
	Category  string         `json:"category"`
	Message   string         `json:"message"`
	Retryable bool           `json:"retryable"`
	RequestID string         `json:"request_id"`
	Details   map[string]any `json:"details,omitempty"`
	Error     apierror.Error `json:"error"`
}

func writeRegistryError(w http.ResponseWriter, status int, envelope apierror.Error) {
	w.Header().Set("X-Request-ID", envelope.RequestID)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, registryErrorResponse{
		Code: envelope.Code, Category: envelope.Category, Message: envelope.Message,
		Retryable: envelope.Retryable, RequestID: envelope.RequestID,
		Details: envelope.Details, Error: envelope,
	})
}

func writeError(w http.ResponseWriter, err error) {
	code := Code(err)
	status := http.StatusServiceUnavailable
	switch code {
	case apierror.OrganizationMismatch, apierror.ActorMismatch:
		writeBoundaryError(w, http.StatusForbidden, code, err.Error(), false)
		return
	case apierror.InvalidRequest, apierror.InvalidPackage:
		status = http.StatusBadRequest
	case apierror.NotFound:
		status = http.StatusNotFound
	case apierror.NameConflict, apierror.RequestConflict, apierror.RevisionConflict, apierror.ContentChanged:
		status = http.StatusConflict
	case apierror.LimitExceeded:
		status = http.StatusRequestEntityTooLarge
	case apierror.Busy:
		status = http.StatusTooManyRequests
	case apierror.SourceInvalid:
		status = http.StatusBadGateway
	}
	message := "Registry temporarily unavailable"
	var typed *Error
	if errors.As(err, &typed) {
		message = typed.Text
	}
	writeRegistryError(w, status, apierror.New(code, strings.TrimSpace(message), w.Header().Get("X-Request-ID")))
}
