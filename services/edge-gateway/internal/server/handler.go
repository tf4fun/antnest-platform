package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"soft/antnest-platform/services/edge-gateway/internal/identity"
	"soft/antnest-platform/services/edge-gateway/internal/session"
)

const (
	HeaderUserID             = "X-Antnest-User-ID"
	HeaderOrganizationID     = "X-Antnest-Organization-ID"
	HeaderMembershipID       = "X-Antnest-Membership-ID"
	HeaderSystemRole         = "X-Antnest-System-Role"
	HeaderOrganizationRole   = "X-Antnest-Organization-Role"
	HeaderTraceID            = "X-Antnest-Trace-ID"
	HeaderAgentAccessSubject = "X-Antnest-Agent-Access-Subject"
	maximumLoginBytes        = 64 << 10
	defaultStreamLease       = 5 * time.Minute
	defaultLoginWindow       = 5 * time.Minute
	defaultLoginSourceMax    = 30
	defaultLoginAccountMax   = 10
	defaultLoginMaxKeys      = 4096
)

var trustedHeaders = []string{
	HeaderUserID, HeaderOrganizationID, HeaderMembershipID,
	HeaderSystemRole, HeaderOrganizationRole, HeaderAgentAccessSubject,
}

type IdentityService interface {
	Login(context.Context, identity.LoginInput) (identity.LoginResult, error)
	ListLoginMethods(context.Context, string) ([]identity.LoginMethod, error)
	StartOIDCLogin(context.Context, identity.StartOIDCLoginInput) (identity.StartOIDCLoginResult, error)
	CompleteOIDCLogin(context.Context, identity.OIDCCallbackInput) (identity.OIDCCallbackResult, error)
	Resolve(context.Context, string) (identity.Principal, error)
	RevokeByAccessToken(context.Context, string) (identity.RevokeStatus, error)
	Ready(context.Context) error
}

type Config struct {
	AdminConsoleURL string
	AgentUIURL      string
	AgentACPURL     string
	IdentityURL     string
	RequestTimeout  time.Duration
	StreamLease     time.Duration
	LoginWindow     time.Duration
	LoginSourceMax  int
	LoginAccountMax int
	Now             func() time.Time
	NewRequestID    func() string
}

type Dependencies struct {
	Identity   IdentityService
	Agents     agentcontroller.Service
	Sessions   *session.Manager
	HTTPClient *http.Client
	Logger     *slog.Logger
}

type handler struct {
	identity       IdentityService
	agents         agentcontroller.Service
	sessions       *session.Manager
	requestTimeout time.Duration
	streamLease    time.Duration
	loginWindow    time.Duration
	loginAdmission *loginAdmission
	newRequestID   func() string
	httpClient     *http.Client
	logger         *slog.Logger
	consoleURL     *url.URL
	agentUIURL     *url.URL
	agentACPURL    *url.URL
	acpConnections chan struct{}
	acpMessages    chan struct{}
	adminProxy     *httputil.ReverseProxy
	appProxy       *httputil.ReverseProxy
	workspaceProxy *httputil.ReverseProxy
	scimProxy      *httputil.ReverseProxy
	mux            *http.ServeMux
}

func NewHandler(config Config, dependencies Dependencies) (http.Handler, error) {
	consoleURL, err := parseServiceURL(config.AdminConsoleURL)
	if err != nil {
		return nil, fmt.Errorf("admin console URL is invalid")
	}
	agentUIURL, err := parseServiceURL(config.AgentUIURL)
	if err != nil {
		return nil, fmt.Errorf("agent UI URL is invalid")
	}
	agentACPURL, err := parseServiceURL(config.AgentACPURL)
	if err != nil {
		return nil, fmt.Errorf("agent ACP URL is invalid")
	}
	identityURL, err := parseServiceURL(config.IdentityURL)
	if err != nil {
		return nil, fmt.Errorf("identity service URL is invalid")
	}
	if dependencies.Identity == nil || dependencies.Agents == nil ||
		dependencies.Sessions == nil || dependencies.HTTPClient == nil {
		return nil, fmt.Errorf("gateway dependencies are incomplete")
	}
	if dependencies.Logger == nil {
		dependencies.Logger = slog.Default()
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.StreamLease <= 0 {
		config.StreamLease = defaultStreamLease
	}
	if config.LoginWindow <= 0 {
		config.LoginWindow = defaultLoginWindow
	}
	if config.LoginSourceMax <= 0 {
		config.LoginSourceMax = defaultLoginSourceMax
	}
	if config.LoginAccountMax <= 0 {
		config.LoginAccountMax = defaultLoginAccountMax
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewRequestID == nil {
		config.NewRequestID = randomRequestID
	}
	h := &handler{
		identity: dependencies.Identity, agents: dependencies.Agents, sessions: dependencies.Sessions,
		requestTimeout: config.RequestTimeout, streamLease: config.StreamLease,
		loginWindow: config.LoginWindow,
		loginAdmission: newLoginAdmission(loginAdmissionConfig{
			Window: config.LoginWindow, SourceLimit: config.LoginSourceMax,
			AccountLimit: config.LoginAccountMax, MaxKeys: defaultLoginMaxKeys, Now: config.Now,
		}),
		newRequestID: config.NewRequestID,
		httpClient:   dependencies.HTTPClient, logger: dependencies.Logger,
		consoleURL: consoleURL, agentUIURL: agentUIURL, agentACPURL: agentACPURL,
		acpConnections: make(chan struct{}, 64), acpMessages: make(chan struct{}, 4),
		mux: http.NewServeMux(),
	}
	h.adminProxy = h.newProxy(consoleURL, "console_unavailable", "Admin Console is unavailable", nil)
	h.appProxy = h.newProxy(consoleURL, "console_unavailable", "Admin Console is unavailable", nil)
	h.workspaceProxy = h.newProxy(
		agentUIURL, "workspace_unavailable", "Agent workspace is unavailable", stripWorkspacePath,
	)
	h.scimProxy = h.newSCIMProxy(identityURL)
	h.routes()
	return h, nil
}

func (h *handler) routes() {
	h.mux.HandleFunc("GET /status", h.status)
	h.mux.HandleFunc("POST /api/session/login", h.login)
	h.mux.HandleFunc("POST /api/session/login-methods", h.loginMethods)
	h.mux.HandleFunc("POST /api/session/oidc/start", h.startOIDCLogin)
	h.mux.HandleFunc("GET /api/session", h.getSession)
	h.mux.HandleFunc("DELETE /api/session", h.logout)
	h.mux.HandleFunc("GET /api/app/bootstrap", h.workspaceBootstrap)
	for _, route := range []struct{ suffix, version string }{
		{"acp", "v1"}, {"v1/acp", "v1"}, {"v2/acp", "v2"},
	} {
		h.mux.HandleFunc("GET /api/app/agents/{agent_id}/"+route.suffix,
			func(response http.ResponseWriter, request *http.Request) {
				request.SetPathValue("acp_version", route.version)
				h.workspaceACP(response, request)
			})
		if route.version == "v1" {
			for _, method := range []string{http.MethodPost, http.MethodDelete} {
				h.mux.HandleFunc(method+" /api/app/agents/{agent_id}/"+route.suffix,
					func(response http.ResponseWriter, request *http.Request) {
						request.SetPathValue("acp_version", "v1")
						h.workspaceACP(response, request)
					})
			}
		}
	}
	h.mux.HandleFunc("/api/app/{path...}", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("GET /protocol/oidc/callback", h.oidcCallback)
	h.mux.HandleFunc("/protocol/oidc", h.unknownIdentityProtocol)
	h.mux.HandleFunc("/protocol/oidc/{path...}", h.unknownIdentityProtocol)
	h.mux.Handle("/scim/v2", h.scimProxy)
	h.mux.Handle("/scim/v2/{path...}", h.scimProxy)
	h.mux.HandleFunc("/api/admin", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("/api/admin/{path...}", h.admin)
	h.mux.HandleFunc("/api/{path...}", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("/workspace", h.workspaceApplication)
	h.mux.HandleFunc("/workspace/{path...}", h.workspaceApplication)
	h.mux.HandleFunc("/{path...}", h.application)
}

func (*handler) unknownIdentityProtocol(response http.ResponseWriter, _ *http.Request) {
	writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
}

func (h *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	for _, name := range trustedHeaders {
		request.Header.Del(name)
	}
	setSecurityHeaders(response)
	if spanContext := trace.SpanContextFromContext(request.Context()); spanContext.IsValid() {
		response.Header().Set(HeaderTraceID, spanContext.TraceID().String())
	}
	h.mux.ServeHTTP(response, request)
}

func (h *handler) status(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	if err := h.identity.Ready(ctx); err != nil || h.agents.Ready(ctx) != nil ||
		h.serviceReady(ctx, h.consoleURL) != nil || h.serviceReady(ctx, h.agentUIURL) != nil ||
		h.serviceReady(ctx, h.agentACPURL) != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handler) login(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		OrganizationSlug string `json:"organization_slug"`
		Email            string `json:"email"`
		Password         string `json:"password"`
	}
	if !decodeJSON(response, request, maximumLoginBytes, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationSlug) == "" || strings.TrimSpace(payload.Email) == "" ||
		payload.Password == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required login field is empty")
		return
	}
	if !h.admitLogin(response, request, payload.OrganizationSlug, payload.Email) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.Login(ctx, identity.LoginInput{
		RequestID: h.newRequestID(), OrganizationSlug: strings.TrimSpace(payload.OrganizationSlug),
		Email: strings.TrimSpace(payload.Email), Password: payload.Password,
	})
	if err != nil {
		h.writeIdentityError(response, err)
		return
	}
	if !result.Principal.Active {
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is inactive")
		return
	}
	if _, err := h.sessions.Establish(response, result.AccessToken, result.ExpiresAt); err != nil {
		h.logger.ErrorContext(request.Context(), "Failed to establish browser session", "error_class", "session_error")
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be established")
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, map[string]any{
		"principal": result.Principal, "expires_at": result.ExpiresAt,
	})
}

func (h *handler) loginMethods(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		OrganizationSlug string `json:"organization_slug"`
	}
	if !decodeJSON(response, request, maximumLoginBytes, &payload) {
		return
	}
	organizationSlug := strings.TrimSpace(payload.OrganizationSlug)
	if organizationSlug == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Organization is required")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	methods, err := h.identity.ListLoginMethods(ctx, organizationSlug)
	if err != nil {
		h.writePublicOIDCError(response, err)
		return
	}
	if methods == nil {
		methods = []identity.LoginMethod{}
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, map[string]any{"methods": methods})
}

func (h *handler) startOIDCLogin(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		OrganizationSlug string `json:"organization_slug"`
		ProviderName     string `json:"provider_name"`
	}
	if !decodeJSON(response, request, maximumLoginBytes, &payload) {
		return
	}
	organizationSlug := strings.TrimSpace(payload.OrganizationSlug)
	providerName := strings.TrimSpace(payload.ProviderName)
	if organizationSlug == "" || providerName == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Organization and login method are required")
		return
	}
	if !h.admitLogin(response, request, organizationSlug, "oidc:"+providerName) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.StartOIDCLogin(ctx, identity.StartOIDCLoginInput{
		RequestID: h.newRequestID(), OrganizationSlug: organizationSlug, ProviderName: providerName,
	})
	if err != nil {
		h.writePublicOIDCError(response, err)
		return
	}
	if err := h.sessions.BindOIDC(response, result.AuthorizationURL, result.ExpiresAt); err != nil {
		h.writePublicOIDCError(response, err)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, result)
}

func (h *handler) oidcCallback(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		h.redirectOIDCFailure(response, request)
		return
	}
	input := identity.OIDCCallbackInput{
		State: strings.TrimSpace(query.Get("state")), Code: strings.TrimSpace(query.Get("code")),
		AuthorizationError: strings.TrimSpace(query.Get("error")),
	}
	if input.State == "" || (input.Code == "") == (input.AuthorizationError == "") {
		h.redirectOIDCFailure(response, request)
		return
	}
	for _, name := range []string{"state", "code", "error"} {
		if len(query[name]) > 1 {
			h.redirectOIDCFailure(response, request)
			return
		}
	}
	if !h.sessions.MatchesOIDC(request, input.State) {
		h.redirectOIDCFailure(response, request)
		return
	}
	h.sessions.ClearOIDC(response)
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.CompleteOIDCLogin(ctx, input)
	if err != nil || result.AccessToken == "" || !result.Principal.Active {
		h.redirectOIDCFailure(response, request)
		return
	}
	if _, err := h.sessions.Establish(response, result.AccessToken, result.ExpiresAt); err != nil {
		h.logger.ErrorContext(request.Context(), "Failed to establish OIDC browser session", "error_class", "session_error")
		h.redirectOIDCFailure(response, request)
		return
	}
	http.Redirect(response, request, "/", http.StatusSeeOther)
}

func (*handler) redirectOIDCFailure(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	http.Redirect(response, request, "/?auth_error=oidc_login_failed", http.StatusSeeOther)
}

func (h *handler) getSession(response http.ResponseWriter, request *http.Request) {
	_, principal, ok := h.authenticate(response, request)
	if !ok {
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, map[string]any{"principal": principal})
}

func (h *handler) logout(response http.ResponseWriter, request *http.Request) {
	values, ok := h.sessions.Read(request)
	if !ok {
		h.sessions.Clear(response)
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if !h.sessions.ValidCSRF(request, values) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	if _, err := h.identity.RevokeByAccessToken(ctx, values.AccessToken); err != nil {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be revoked")
		return
	}
	h.sessions.Clear(response)
	response.WriteHeader(http.StatusNoContent)
}

type workspacePrincipalResponse struct {
	UserID         string `json:"user_id"`
	OrganizationID string `json:"organization_id"`
	Administrator  bool   `json:"administrator"`
}

type workspaceAgentResponse struct {
	AgentID      string `json:"agent_id"`
	Name         string `json:"name"`
	Availability string `json:"availability"`
}

type workspaceBootstrapResponse struct {
	Principal workspacePrincipalResponse `json:"principal"`
	Agents    []workspaceAgentResponse   `json:"agents"`
}

func (h *handler) workspaceBootstrap(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	_, principal, ok := h.authenticate(response, request)
	if !ok {
		return
	}
	agents, err := h.workspaceAgents(request.Context(), principal)
	if err != nil {
		h.logger.ErrorContext(request.Context(), "Workspace bootstrap failed", "error_class", "upstream_unavailable")
		writeError(response, http.StatusServiceUnavailable, "workspace_unavailable", "Agent workspace is unavailable")
		return
	}
	items := make([]workspaceAgentResponse, 0, len(agents))
	for _, agent := range agents {
		items = append(items, workspaceAgentResponse{
			AgentID: agent.AgentID, Name: agent.Name, Availability: agent.Availability,
		})
	}
	writeJSON(response, http.StatusOK, workspaceBootstrapResponse{
		Principal: workspacePrincipalResponse{
			UserID: principal.UserID, OrganizationID: principal.OrganizationID,
			Administrator: principal.Administrator(),
		},
		Agents: items,
	})
}

func (h *handler) workspaceACP(response http.ResponseWriter, request *http.Request) {
	upgrade := webSocketUpgrade(request)
	if !upgrade && request.PathValue("acp_version") != "v1" {
		writeError(response, http.StatusBadRequest, "invalid_request", "WebSocket upgrade is required")
		return
	}
	if (upgrade || request.Header.Get("Origin") != "") && !sameOrigin(request) {
		writeError(response, http.StatusForbidden, "forbidden", "ACP origin is not allowed")
		return
	}
	permits := h.acpConnections
	if !upgrade && request.Method != http.MethodGet {
		permits = h.acpMessages
	}
	select {
	case permits <- struct{}{}:
		defer func() { <-permits }()
	default:
		writeError(response, http.StatusServiceUnavailable, "agent_unavailable", "Agent connection capacity is unavailable")
		return
	}
	values, principal, ok := h.authenticate(response, request)
	if !ok {
		return
	}
	if !upgrade && stateChanging(request.Method) && !h.sessions.ValidCSRF(request, values) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return
	}
	agents, err := h.workspaceAgents(request.Context(), principal)
	if err != nil {
		h.logger.ErrorContext(request.Context(), "Agent connection admission failed", "error_class", "upstream_unavailable")
		writeError(response, http.StatusServiceUnavailable, "agent_unavailable", "Agent connection is unavailable")
		return
	}
	requestedID := request.PathValue("agent_id")
	for _, agent := range agents {
		if agent.AgentID != requestedID {
			continue
		}
		if upgrade {
			h.relayWorkspaceACP(response, request, values.AccessToken, principal, agent.AgentAccessSubject)
		} else {
			h.relayWorkspaceHTTP(response, request, agent.AgentAccessSubject)
		}
		return
	}
	writeError(response, http.StatusNotFound, "agent_not_found", "Agent was not found")
}

func (h *handler) workspaceAgents(
	ctx context.Context, principal identity.Principal,
) ([]agentcontroller.WorkspaceAgent, error) {
	ctx, cancel := context.WithTimeout(ctx, h.requestTimeout)
	defer cancel()
	return h.agents.ListWorkspaceAgents(ctx, agentcontroller.ListWorkspaceAgentsInput{
		RequestID: h.newRequestID(), OrganizationID: principal.OrganizationID,
		PrincipalID: principal.UserID,
	})
}

func (h *handler) workspaceApplication(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
		return
	}
	if request.URL.Path == "/workspace" {
		http.Redirect(response, request, "/workspace/", http.StatusTemporaryRedirect)
		return
	}
	request.Header.Del("Cookie")
	request.Header.Del("Authorization")
	h.workspaceProxy.ServeHTTP(response, request)
}

func webSocketUpgrade(request *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") &&
		headerContainsToken(request.Header.Values("Connection"), "upgrade")
}

func headerContainsToken(values []string, wanted string) bool {
	for _, value := range values {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), wanted) {
				return true
			}
		}
	}
	return false
}

func sameOrigin(request *http.Request) bool {
	origin, err := url.Parse(strings.TrimSpace(request.Header.Get("Origin")))
	return err == nil && (origin.Scheme == "http" || origin.Scheme == "https") &&
		strings.EqualFold(origin.Host, request.Host)
}

func (h *handler) admin(response http.ResponseWriter, request *http.Request) {
	values, principal, ok := h.authenticate(response, request)
	if !ok {
		return
	}
	if !principal.Administrator() {
		writeError(response, http.StatusForbidden, "forbidden", "Administrator access is required")
		return
	}
	if stateChanging(request.Method) && !h.sessions.ValidCSRF(request, values) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return
	}
	setPrincipalHeaders(request.Header, principal)
	request.Header.Del("Cookie")
	request.Header.Del("Authorization")
	if isAgentEventWatch(request) {
		ctx, cancel := context.WithTimeout(request.Context(), h.streamLease)
		defer cancel()
		request = request.WithContext(ctx)
	}
	h.adminProxy.ServeHTTP(response, request)
}

func (h *handler) application(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
		return
	}
	request.Header.Del("Cookie")
	request.Header.Del("Authorization")
	h.appProxy.ServeHTTP(response, request)
}

func (h *handler) authenticate(
	response http.ResponseWriter,
	request *http.Request,
) (session.Values, identity.Principal, bool) {
	response.Header().Set("Cache-Control", "no-store")
	values, ok := h.sessions.Read(request)
	if !ok {
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Login is required")
		return session.Values{}, identity.Principal{}, false
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	principal, err := h.identity.Resolve(ctx, values.AccessToken)
	if err != nil && !identity.IsCode(err, "unauthenticated") && !identity.IsCode(err, "inactive_principal") {
		h.logger.ErrorContext(request.Context(), "Session validation unavailable", "error_class", "identity_unavailable")
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return session.Values{}, identity.Principal{}, false
	}
	if err != nil || !principal.Active {
		h.sessions.Clear(response)
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is invalid or expired")
		return session.Values{}, identity.Principal{}, false
	}
	return values, principal, true
}

func (h *handler) newProxy(
	target *url.URL, errorCode string, errorMessage string,
	rewritePath func(*http.Request) string,
) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{}
	proxy.Rewrite = func(request *httputil.ProxyRequest) {
		request.SetURL(target)
		if rewritePath != nil {
			request.Out.URL.Path = rewritePath(request.In)
			request.Out.URL.RawPath = ""
		}
		request.SetXForwarded()
		request.Out.Host = target.Host
		request.Out.Header.Del("Cookie")
		request.Out.Header.Del("Authorization")
		otel.GetTextMapPropagator().Inject(
			request.Out.Context(), propagation.HeaderCarrier(request.Out.Header),
		)
	}
	proxy.Transport = h.httpClient.Transport
	if proxy.Transport == nil {
		proxy.Transport = http.DefaultTransport
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, err error) {
		h.logger.ErrorContext(request.Context(), "Gateway proxy failed", "error_class", "upstream_unavailable")
		writeError(response, http.StatusServiceUnavailable, errorCode, errorMessage)
	}
	return proxy
}

func (h *handler) newSCIMProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{}
	proxy.Rewrite = func(request *httputil.ProxyRequest) {
		request.SetURL(target)
		request.SetXForwarded()
		request.Out.Host = target.Host
		request.Out.Header.Del("Cookie")
		otel.GetTextMapPropagator().Inject(
			request.Out.Context(), propagation.HeaderCarrier(request.Out.Header),
		)
	}
	proxy.Transport = h.httpClient.Transport
	if proxy.Transport == nil {
		proxy.Transport = http.DefaultTransport
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, _ error) {
		h.logger.ErrorContext(request.Context(), "SCIM proxy failed", "error_class", "upstream_unavailable")
		response.Header().Set("Content-Type", "application/scim+json")
		response.Header().Set("Cache-Control", "no-store")
		response.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(response).Encode(map[string]any{
			"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:Error"},
			"status":  "503",
			"detail":  "Identity Service is unavailable",
		})
	}
	return proxy
}

func (h *handler) serviceReady(ctx context.Context, service *url.URL) error {
	target := service.ResolveReference(&url.URL{Path: "/status"})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := h.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("service status %d", response.StatusCode)
	}
	return nil
}

func parseServiceURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("invalid service URL")
	}
	return parsed, nil
}

func stripWorkspacePath(request *http.Request) string {
	path := strings.TrimPrefix(request.URL.Path, "/workspace")
	if path == "" {
		return "/"
	}
	return path
}

func (h *handler) writeIdentityError(response http.ResponseWriter, err error) {
	switch {
	case identity.IsCode(err, "unauthenticated"), identity.IsCode(err, "inactive_principal"):
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Email or password is incorrect")
	case identity.IsCode(err, "forbidden"):
		writeError(response, http.StatusForbidden, "forbidden", "Login is not allowed")
	default:
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Identity Service is unavailable")
	}
}

func (h *handler) admitLogin(
	response http.ResponseWriter, request *http.Request, organization, account string,
) bool {
	if h.loginAdmission.Allow(requestSource(request), organization, account) {
		return true
	}
	response.Header().Set("Retry-After", fmt.Sprintf("%.0f", h.loginWindow.Seconds()))
	writeError(response, http.StatusTooManyRequests, "login_rate_limited", "Too many login attempts")
	return false
}

func (h *handler) writePublicOIDCError(response http.ResponseWriter, err error) {
	switch {
	case identity.IsCode(err, "bad_request"), identity.IsCode(err, "invalid_argument"):
		writeError(response, http.StatusBadRequest, "invalid_request", "Login request is invalid")
	case identity.IsCode(err, "forbidden"), identity.IsCode(err, "not_found"):
		writeError(response, http.StatusBadRequest, "login_method_unavailable", "Login method is unavailable")
	default:
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Identity Service is unavailable")
	}
}

func setPrincipalHeaders(header http.Header, principal identity.Principal) {
	header.Set(HeaderUserID, principal.UserID)
	header.Set(HeaderOrganizationID, principal.OrganizationID)
	header.Set(HeaderMembershipID, principal.MembershipID)
	header.Set(HeaderSystemRole, principal.SystemRole)
	header.Set(HeaderOrganizationRole, principal.OrganizationRole)
}

func setSecurityHeaders(response http.ResponseWriter) {
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Referrer-Policy", "same-origin")
	response.Header().Set("X-Frame-Options", "DENY")
	response.Header().Set("Content-Security-Policy",
		"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'")
}

func stateChanging(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}

func requestSource(request *http.Request) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(request.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	if source := strings.TrimSpace(request.RemoteAddr); source != "" {
		return source
	}
	return "unknown"
}

func isAgentEventWatch(request *http.Request) bool {
	return request.Method == http.MethodGet &&
		strings.HasPrefix(request.URL.Path, "/api/admin/agents/") &&
		strings.HasSuffix(request.URL.Path, "/events/watch")
}

func decodeJSON(response http.ResponseWriter, request *http.Request, limit int64, target any) bool {
	if mediaType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])); mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "invalid_request", "Content-Type must be application/json")
		return false
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, limit))
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

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, status, map[string]any{"code": code, "message": message})
}

func randomRequestID() string {
	payload := make([]byte, 16)
	if _, err := rand.Read(payload); err != nil {
		return fmt.Sprintf("edge-%d", time.Now().UnixNano())
	}
	return "edge-" + hex.EncodeToString(payload)
}
