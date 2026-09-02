package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

const (
	maximumRequestBytes        = 2 << 20
	maximumResponseBytes       = 16 << 20
	defaultMemoryBytes         = int64(1 << 30)
	defaultPIDsLimit           = int64(256)
	defaultTmpfsBytes          = int64(256 << 20)
	minimumIdempotencyKeyBytes = 16
	maximumIdempotencyKeyBytes = 200
)

type Backend interface {
	Do(context.Context, upstream.Target, string, string, string, []byte) (*http.Response, error)
	Ready(context.Context, upstream.Target) error
}

type Config struct {
	DefaultRuntimeImageRef string
	RequestTimeout         time.Duration
	NewRequestID           func() string
}

type Dependencies struct {
	Backend Backend
	Assets  fs.FS
	Logger  *slog.Logger
}

type handler struct {
	backend                Backend
	assets                 fs.FS
	fileServer             http.Handler
	logger                 *slog.Logger
	defaultRuntimeImageRef string
	requestTimeout         time.Duration
	newRequestID           func() string
	mux                    *http.ServeMux
}

func NewHandler(config Config, dependencies Dependencies) (http.Handler, error) {
	if dependencies.Backend == nil || dependencies.Assets == nil {
		return nil, fmt.Errorf("admin console dependencies are incomplete")
	}
	if dependencies.Logger == nil {
		dependencies.Logger = slog.Default()
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 15 * time.Second
	}
	if config.NewRequestID == nil {
		config.NewRequestID = randomRequestID
	}
	h := &handler{
		backend: dependencies.Backend, assets: dependencies.Assets,
		fileServer: http.FileServer(http.FS(dependencies.Assets)), logger: dependencies.Logger,
		defaultRuntimeImageRef: strings.TrimSpace(config.DefaultRuntimeImageRef),
		requestTimeout:         config.RequestTimeout, newRequestID: config.NewRequestID,
		mux: http.NewServeMux(),
	}
	h.routes()
	return h, nil
}

func (h *handler) routes() {
	h.mux.HandleFunc("GET /status", h.status)
	h.mux.HandleFunc("GET /api/admin/overview", h.withPrincipal(h.overview))
	h.mux.HandleFunc("GET /api/admin/directory", h.withPrincipal(h.directory))
	h.mux.HandleFunc("GET /api/admin/model-profiles", h.withPrincipal(h.listModelProfiles))
	h.mux.HandleFunc("POST /api/admin/model-profiles", h.withPrincipal(h.createModelProfile))
	h.mux.HandleFunc("GET /api/admin/templates", h.withPrincipal(h.listTemplates))
	h.mux.HandleFunc("POST /api/admin/templates", h.withPrincipal(h.createTemplate))
	h.mux.HandleFunc("GET /api/admin/agents", h.withPrincipal(h.listAgents))
	h.mux.HandleFunc("POST /api/admin/agents", h.withPrincipal(h.createAgent))
	h.mux.HandleFunc("GET /api/admin/agents/{agent_id}", h.withPrincipal(h.getAgent))
	for _, action := range []string{"rebuild", "disable", "enable", "delete"} {
		h.mux.HandleFunc("POST /api/admin/agents/{agent_id}/"+action, h.withPrincipal(h.lifecycle(action)))
	}
	h.mux.HandleFunc("GET /api/admin/operations/{request_id}", h.withPrincipal(h.getOperation))
	h.mux.HandleFunc("GET /api/admin/agents/{agent_id}/events", h.withPrincipal(h.listAgentEvents))
	h.mux.HandleFunc("GET /api/admin/agents/{agent_id}/events/watch", h.withPrincipal(h.watchAgentEvents))
	h.mux.HandleFunc("/api/{path...}", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("/{path...}", h.application)
}

func (h *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.mux.ServeHTTP(response, request)
}

type adminHandler func(http.ResponseWriter, *http.Request, principal.Principal)

func (h *handler) withPrincipal(next adminHandler) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, err := principal.FromHeaders(request.Header)
		if err != nil {
			writeError(response, http.StatusUnauthorized, "unauthenticated", "Trusted principal is missing")
			return
		}
		if !actor.Administrator() {
			writeError(response, http.StatusForbidden, "forbidden", "Administrator access is required")
			return
		}
		next(response, request, actor)
	}
}

func (h *handler) status(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	if h.backend.Ready(ctx, upstream.Identity) != nil ||
		h.backend.Ready(ctx, upstream.AgentController) != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handler) directory(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	payload := map[string]string{
		"actor_principal_id": actor.UserID, "organization_id": actor.OrganizationID,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/list-directory", "", payload, projectDirectory)
}

func (h *handler) listModelProfiles(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/model-profiles", organizationQuery(actor.OrganizationID), nil, projectModelProfileList)
}

type createModelProfileInput struct {
	ProfileKey  string          `json:"profile_key"`
	DisplayName string          `json:"display_name"`
	APIKey      string          `json:"api_key"`
	Model       json.RawMessage `json:"model"`
}

func (h *handler) createModelProfile(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input createModelProfileInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.ProfileKey, input.DisplayName, input.APIKey) || len(input.Model) == 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Model Profile field is empty")
		return
	}
	payload := map[string]any{
		"request_id": h.newRequestID(), "organization_id": actor.OrganizationID,
		"profile_key": input.ProfileKey, "display_name": input.DisplayName,
		"model":      input.Model,
		"credential": map[string]string{"secret_type": "bearer", "secret": input.APIKey},
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/model-profiles", "", payload, projectModelProfile)
}

func (h *handler) listTemplates(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agent-templates", organizationQuery(actor.OrganizationID), nil, projectTemplateList)
}

type createTemplateInput struct {
	TemplateKey            string       `json:"template_key"`
	Name                   string       `json:"name"`
	ModelProfileRevisionID string       `json:"model_profile_revision_id"`
	SystemPrompt           string       `json:"system_prompt"`
	MaxModelRequests       int          `json:"max_model_requests,omitempty"`
	Runtime                runtimeInput `json:"runtime,omitempty"`
}

type runtimeInput struct {
	ImageRef  string        `json:"image_ref,omitempty"`
	Resources resourceInput `json:"resources,omitempty"`
}

type resourceInput struct {
	MemoryBytes int64 `json:"memory_bytes,omitempty"`
	PIDsLimit   int64 `json:"pids_limit,omitempty"`
	TmpfsBytes  int64 `json:"tmpfs_bytes,omitempty"`
}

func (h *handler) createTemplate(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input createTemplateInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.TemplateKey, input.Name, input.ModelProfileRevisionID) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Template field is empty")
		return
	}
	if input.MaxModelRequests == 0 {
		input.MaxModelRequests = 32
	}
	if input.Runtime.ImageRef == "" {
		input.Runtime.ImageRef = h.defaultRuntimeImageRef
	}
	if input.Runtime.ImageRef == "" {
		writeError(response, http.StatusBadRequest, "runtime_image_required", "Runtime image digest is required")
		return
	}
	applyResourceDefaults(&input.Runtime.Resources)
	payload := map[string]any{
		"request_id": h.newRequestID(), "organization_id": actor.OrganizationID,
		"template_key": input.TemplateKey, "name": input.Name,
		"model_profile_revision_id": input.ModelProfileRevisionID,
		"system_prompt":             input.SystemPrompt, "max_model_requests": input.MaxModelRequests,
		"context_policy_version": "context-v1", "runtime": input.Runtime,
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/agent-templates", "", payload, projectTemplate)
}

func (h *handler) listAgents(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	query := url.Values{"organization_id": []string{actor.OrganizationID}, "limit": []string{"200"}}
	if request.URL.Query().Get("include_deleted") == "true" {
		query.Set("include_deleted", "true")
	}
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents", query.Encode(), nil, projectAgentList)
}

type createAgentInput struct {
	OwnerUserID      string `json:"owner_user_id"`
	Name             string `json:"name"`
	TemplateID       string `json:"template_id"`
	TemplateRevision int64  `json:"template_revision"`
}

func (h *handler) createAgent(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input createAgentInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.OwnerUserID, input.Name, input.TemplateID) || input.TemplateRevision < 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Agent field is invalid")
		return
	}
	requestID, ok := lifecycleRequestID(response, request, actor.OrganizationID)
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"actor_principal_id": actor.UserID,
		"owner_user_id":      input.OwnerUserID, "name": input.Name,
		"template_id": input.TemplateID, "template_revision": input.TemplateRevision,
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/agents", "", payload, projectCreateAgent)
}

func (h *handler) getAgent(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents/"+url.PathEscape(request.PathValue("agent_id")),
		url.Values{"organization_id": []string{actor.OrganizationID}}.Encode(), nil, projectAgent)
}

func (h *handler) lifecycle(action string) adminHandler {
	return func(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
		agentID := request.PathValue("agent_id")
		requestID, ok := lifecycleRequestID(response, request, actor.OrganizationID)
		if !ok {
			return
		}
		payload := map[string]any{
			"request_id": requestID, "organization_id": actor.OrganizationID,
			"actor_principal_id": actor.UserID,
		}
		if action == "rebuild" {
			var input struct {
				TemplateID       string `json:"template_id"`
				TemplateRevision int64  `json:"template_revision"`
			}
			if !decodeJSON(response, request, &input) {
				return
			}
			if !required(input.TemplateID) || input.TemplateRevision < 1 {
				writeError(response, http.StatusBadRequest, "invalid_request", "Template revision is required")
				return
			}
			payload["template_id"] = input.TemplateID
			payload["template_revision"] = input.TemplateRevision
		} else if !decodeEmptyObject(response, request) {
			return
		}
		h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
			"/internal/agents/"+url.PathEscape(agentID)+"/"+action, "", payload, projectOperation)
	}
}

func (h *handler) getOperation(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agent-operations/"+url.PathEscape(request.PathValue("request_id")),
		url.Values{"organization_id": []string{actor.OrganizationID}}.Encode(), nil, projectOperation)
}

func (h *handler) listAgentEvents(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	agentID := request.PathValue("agent_id")
	queryValues := eventQueryValues(request.URL.Query())
	queryValues.Set("organization_id", actor.OrganizationID)
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents/"+url.PathEscape(agentID)+"/events", queryValues.Encode(), nil, projectAgentEventList)
}

func (h *handler) watchAgentEvents(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	agentID := request.PathValue("agent_id")
	queryValues := eventWatchQueryValues(request.URL.Query())
	queryValues.Set("organization_id", actor.OrganizationID)
	h.streamProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents/"+url.PathEscape(agentID)+"/events/watch",
		queryValues.Encode(), nil, projectAgentEvent)
}

func (h *handler) overview(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	calls := []overviewCall{
		{target: upstream.Identity, method: http.MethodPost, path: "/rpc/identity/list-directory",
			body: map[string]string{"actor_principal_id": actor.UserID, "organization_id": actor.OrganizationID},
			name: "directory", projector: projectDirectory},
		{target: upstream.AgentController, method: http.MethodGet, path: "/internal/model-profiles",
			query: organizationQuery(actor.OrganizationID), name: "model_profiles", projector: projectModelProfileList},
		{target: upstream.AgentController, method: http.MethodGet, path: "/internal/agent-templates",
			query: organizationQuery(actor.OrganizationID), name: "templates", projector: projectTemplateList},
		{target: upstream.AgentController, method: http.MethodGet, path: "/internal/agents",
			query: url.Values{"organization_id": []string{actor.OrganizationID}, "limit": []string{"200"}}.Encode(),
			name:  "agents", projector: projectAgentList},
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	results := h.fetchOverview(ctx, calls)
	agents := results["agents"]
	if agents.err != nil || !successful(agents.response.status) {
		h.logger.ErrorContext(request.Context(), "Agent inventory overview read failed",
			"dependency", upstream.AgentController, "error_class", "agent_inventory_unavailable")
		writeError(response, http.StatusServiceUnavailable,
			"agent_inventory_unavailable", "Agent inventory is unavailable")
		return
	}
	payload := overviewResponse{
		Directory:     overviewSectionFromResult(results["directory"]),
		ModelProfiles: overviewSectionFromResult(results["model_profiles"]),
		Templates:     overviewSectionFromResult(results["templates"]),
		Agents:        overviewSectionFromResult(agents),
		Defaults:      map[string]string{"runtime_image_ref": h.defaultRuntimeImageRef},
	}
	writeJSON(response, http.StatusOK, payload)
}

type overviewCall struct {
	target    upstream.Target
	method    string
	path      string
	query     string
	body      any
	name      string
	projector payloadProjector
}

type overviewCallResult struct {
	response bufferedResponse
	err      error
}

type overviewError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type overviewSection struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  *overviewError  `json:"error,omitempty"`
}

type overviewResponse struct {
	Directory     overviewSection   `json:"directory"`
	ModelProfiles overviewSection   `json:"model_profiles"`
	Templates     overviewSection   `json:"templates"`
	Agents        overviewSection   `json:"agents"`
	Defaults      map[string]string `json:"defaults"`
}

func (h *handler) fetchOverview(ctx context.Context, calls []overviewCall) map[string]overviewCallResult {
	results := make(map[string]overviewCallResult, len(calls))
	var mutex sync.Mutex
	var group sync.WaitGroup
	group.Add(len(calls))
	for _, item := range calls {
		call := item
		go func() {
			defer group.Done()
			var body []byte
			var err error
			if call.body != nil {
				body, err = json.Marshal(call.body)
			}
			var result bufferedResponse
			if err == nil {
				result, err = h.fetchBuffered(ctx, call.target, call.method, call.path, call.query, body)
			}
			if err == nil && successful(result.status) && call.projector != nil {
				result.body, err = call.projector(result.body)
			}
			mutex.Lock()
			results[call.name] = overviewCallResult{response: result, err: err}
			mutex.Unlock()
		}()
	}
	group.Wait()
	return results
}

func overviewSectionFromResult(result overviewCallResult) overviewSection {
	if result.err != nil {
		return overviewSection{
			Status: "unavailable",
			Error:  &overviewError{Code: "dependency_unavailable", Message: "Section could not be refreshed"},
		}
	}
	if !successful(result.response.status) {
		return overviewSection{
			Status: "unavailable",
			Error:  &overviewError{Code: "upstream_rejected", Message: "Section could not be refreshed"},
		}
	}
	return overviewSection{Status: "available", Data: json.RawMessage(result.response.body)}
}

func successful(status int) bool {
	return status >= http.StatusOK && status < http.StatusMultipleChoices
}

type bufferedResponse struct {
	status int
	header http.Header
	body   []byte
}

func (h *handler) forwardProjectedJSON(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	payload any,
	projector payloadProjector,
) {
	body, err := json.Marshal(payload)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encoding_failed", "Request could not be encoded")
		return
	}
	h.forwardProjected(response, request, target, method, path, query, body, projector)
}

func (h *handler) forwardProjected(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
	projector payloadProjector,
) {
	result, ok := h.read(response, request, target, method, path, query, body)
	if !ok {
		return
	}
	if successful(result.status) {
		projected, err := projector(result.body)
		if err != nil {
			h.logger.ErrorContext(request.Context(), "Admin Console response projection failed",
				"dependency", target, "error_class", "invalid_upstream_response")
			writeError(response, http.StatusBadGateway, "invalid_upstream_response", "Platform response is invalid")
			return
		}
		result.body = projected
		result.header.Set("Content-Type", "application/json")
	}
	writeRaw(response, result.status, result.header, result.body)
}

func (h *handler) read(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
) (bufferedResponse, bool) {
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.fetchBuffered(ctx, target, method, path, query, body)
	if err != nil {
		h.logger.ErrorContext(request.Context(), "Admin Console dependency failed",
			"dependency", target, "error_class", "upstream_unavailable")
		var failure *bufferedFetchError
		if errors.As(err, &failure) {
			writeError(response, failure.status, failure.code, failure.message)
		} else {
			writeError(response, http.StatusServiceUnavailable, "dependency_unavailable", "A platform service is unavailable")
		}
		return bufferedResponse{}, false
	}
	return result, true
}

type bufferedFetchError struct {
	status  int
	code    string
	message string
	cause   error
}

func (failure *bufferedFetchError) Error() string { return failure.message }

func (failure *bufferedFetchError) Unwrap() error { return failure.cause }

func (h *handler) fetchBuffered(
	ctx context.Context,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
) (bufferedResponse, error) {
	upstreamResponse, err := h.backend.Do(ctx, target, method, path, query, body)
	if err != nil {
		return bufferedResponse{}, &bufferedFetchError{
			status: http.StatusServiceUnavailable, code: "dependency_unavailable",
			message: "A platform service is unavailable", cause: err,
		}
	}
	if upstreamResponse == nil || upstreamResponse.Body == nil {
		return bufferedResponse{}, &bufferedFetchError{
			status: http.StatusBadGateway, code: "invalid_upstream_response",
			message: "Platform response is invalid",
		}
	}
	defer func() { _ = upstreamResponse.Body.Close() }()
	payload, readErr := io.ReadAll(io.LimitReader(upstreamResponse.Body, maximumResponseBytes+1))
	if readErr != nil || len(payload) > maximumResponseBytes {
		return bufferedResponse{}, &bufferedFetchError{
			status: http.StatusBadGateway, code: "invalid_upstream_response",
			message: "Platform response is invalid", cause: readErr,
		}
	}
	return bufferedResponse{
		status: upstreamResponse.StatusCode, header: upstreamResponse.Header.Clone(), body: payload,
	}, nil
}

func (h *handler) streamProjected(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
	projector payloadProjector,
) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "streaming_unavailable", "Streaming is unavailable")
		return
	}
	upstreamResponse, err := h.backend.Do(request.Context(), target, method, path, query, body)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "dependency_unavailable", "A platform service is unavailable")
		return
	}
	if upstreamResponse == nil || upstreamResponse.Body == nil {
		writeError(response, http.StatusBadGateway, "invalid_upstream_response", "Platform response is invalid")
		return
	}
	defer func() { _ = upstreamResponse.Body.Close() }()
	if !successful(upstreamResponse.StatusCode) {
		payload, readErr := io.ReadAll(io.LimitReader(upstreamResponse.Body, maximumResponseBytes+1))
		if readErr != nil || len(payload) > maximumResponseBytes {
			writeError(response, http.StatusBadGateway, "invalid_upstream_response", "Platform response is invalid")
			return
		}
		writeRaw(response, upstreamResponse.StatusCode, upstreamResponse.Header, payload)
		return
	}
	copyResponseHeaders(response.Header(), upstreamResponse.Header)
	response.WriteHeader(upstreamResponse.StatusCode)
	flusher.Flush()
	scanner := bufio.NewScanner(upstreamResponse.Body)
	scanner.Buffer(make([]byte, 16<<10), maximumResponseBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if payload, found := strings.CutPrefix(string(line), "data: "); found {
			projected, projectErr := projector([]byte(payload))
			if projectErr != nil {
				h.logger.ErrorContext(request.Context(), "Admin Console event projection failed",
					"dependency", target, "error_class", "invalid_upstream_response")
				return
			}
			line = append([]byte("data: "), projected...)
		}
		if _, err := response.Write(append(line, '\n')); err != nil {
			return
		}
		if len(line) == 0 {
			flusher.Flush()
		}
	}
	if err := scanner.Err(); err != nil && request.Context().Err() == nil {
		h.logger.WarnContext(request.Context(), "Admin Console event stream ended unexpectedly",
			"dependency", target, "error_class", "invalid_upstream_response")
	}
}

func (h *handler) application(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
		return
	}
	clean := strings.TrimPrefix(path.Clean("/"+request.URL.Path), "/")
	if clean != "" && clean != "." {
		if info, err := fs.Stat(h.assets, clean); err == nil && !info.IsDir() {
			h.fileServer.ServeHTTP(response, request)
			return
		}
	}
	index, err := fs.ReadFile(h.assets, "index.html")
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "application_unavailable", "Console application is unavailable")
		return
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Cache-Control", "no-cache")
	response.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = response.Write(index)
	}
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) bool {
	mediaType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "invalid_request", "Content-Type must be application/json")
		return false
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, maximumRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "Request body is invalid")
		return false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Request body must contain one object")
		return false
	}
	return true
}

func decodeEmptyObject(response http.ResponseWriter, request *http.Request) bool {
	var payload map[string]json.RawMessage
	if !decodeJSON(response, request, &payload) {
		return false
	}
	if len(payload) != 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Request body must be empty")
		return false
	}
	return true
}

func applyResourceDefaults(resources *resourceInput) {
	if resources.MemoryBytes == 0 {
		resources.MemoryBytes = defaultMemoryBytes
	}
	if resources.PIDsLimit == 0 {
		resources.PIDsLimit = defaultPIDsLimit
	}
	if resources.TmpfsBytes == 0 {
		resources.TmpfsBytes = defaultTmpfsBytes
	}
}

func organizationQuery(organizationID string) string {
	return url.Values{"organization_id": []string{organizationID}, "limit": []string{"200"}}.Encode()
}

func eventQueryValues(input url.Values) url.Values {
	result := url.Values{}
	if value := input.Get("after_sequence"); value != "" {
		if sequence, err := strconv.ParseInt(value, 10, 64); err == nil && sequence >= 0 {
			result.Set("after_sequence", value)
		}
	}
	result.Set("limit", "200")
	return result
}

func eventWatchQueryValues(input url.Values) url.Values {
	result := url.Values{}
	if value := input.Get("after_sequence"); value != "" {
		if sequence, err := strconv.ParseInt(value, 10, 64); err == nil && sequence >= 0 {
			result.Set("after_sequence", value)
		}
	}
	return result
}

func required(values ...string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return false
		}
	}
	return true
}

func writeRaw(response http.ResponseWriter, status int, header http.Header, payload []byte) {
	copyResponseHeaders(response.Header(), header)
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}

func copyResponseHeaders(target, source http.Header) {
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag", "Last-Modified"} {
		for _, value := range source.Values(name) {
			target.Add(name, value)
		}
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, status, map[string]string{"code": code, "message": message})
}

func randomRequestID() string {
	payload := make([]byte, 16)
	if _, err := rand.Read(payload); err != nil {
		return fmt.Sprintf("console-%d", time.Now().UnixNano())
	}
	return "console-" + hex.EncodeToString(payload)
}

func lifecycleRequestID(
	response http.ResponseWriter, request *http.Request, organizationID string,
) (string, bool) {
	key := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if len(key) < minimumIdempotencyKeyBytes || len(key) > maximumIdempotencyKeyBytes ||
		strings.IndexFunc(key, func(value rune) bool { return value < 0x21 || value > 0x7e }) >= 0 {
		writeError(response, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required")
		return "", false
	}
	digest := sha256.Sum256([]byte(organizationID + "\x00" + key))
	return "lifecycle-" + hex.EncodeToString(digest[:]), true
}
