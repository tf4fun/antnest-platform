package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentacp"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentcontroller"
	gatewayconfig "github.com/tf4fun/antnest-platform/services/edge-gateway/internal/config"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

const (
	HeaderUserID             = "X-Antnest-User-ID"
	HeaderOrganizationID     = "X-Antnest-Organization-ID"
	HeaderOrganizationSlug   = "X-Antnest-Organization-Slug"
	HeaderOrganizationName   = "X-Antnest-Organization-Name"
	HeaderMembershipID       = "X-Antnest-Membership-ID"
	HeaderSystemRole         = "X-Antnest-System-Role"
	HeaderOrganizationRole   = "X-Antnest-Organization-Role"
	HeaderAdministrator      = "X-Antnest-Administrator"
	HeaderPrincipalID        = "X-Antnest-Principal-ID"
	HeaderAgentID            = "X-Antnest-Agent-ID"
	HeaderTraceID            = "X-Antnest-Trace-ID"
	HeaderAgentAccessSubject = "X-Antnest-Agent-Access-Subject"
	maximumLoginBytes        = 64 << 10
	defaultStreamLease       = 5 * time.Minute
	defaultLoginWindow       = 5 * time.Minute
	defaultLoginSourceMax    = 30
	defaultLoginAccountMax   = 10
	defaultLoginMaxKeys      = 4096
)

var errInvalidSession = errors.New("browser session is invalid or missing")

type IdentityService interface {
	Login(context.Context, identity.LoginInput) (identity.LoginResult, error)
	ListLoginMethods(context.Context, string) ([]identity.LoginMethod, error)
	StartOIDCLogin(context.Context, identity.StartOIDCLoginInput) (identity.StartOIDCLoginResult, error)
	CompleteOIDCLogin(context.Context, identity.OIDCCallbackInput) (identity.OIDCCallbackResult, error)
	Resolve(context.Context, string) (identity.Principal, error)
	RevokeByAccessToken(context.Context, string) (identity.RevokeStatus, error)
}

type Config struct {
	PublicOrigin    string
	TrustedProxies  []netip.Prefix
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
	Execution  agentacp.Service
	Sessions   *session.Manager
	HTTPClient *http.Client
	Logger     *slog.Logger
}

type handler struct {
	publicOrigin         *url.URL
	trustedProxies       []netip.Prefix
	identity             IdentityService
	agents               agentcontroller.Service
	execution            agentacp.Service
	sessions             *session.Manager
	requestTimeout       time.Duration
	streamLease          time.Duration
	loginWindow          time.Duration
	loginAdmission       *loginAdmission
	newRequestID         func() string
	httpClient           *http.Client
	logger               *slog.Logger
	consoleURL           *url.URL
	agentUIURL           *url.URL
	agentACPURL          *url.URL
	acpConnections       chan struct{}
	acpMessages          chan struct{}
	stateConnections     chan struct{}
	bridgeStreams        chan struct{}
	adminProxy           *httputil.ReverseProxy
	appProxy             *httputil.ReverseProxy
	workspaceBridgeProxy *httputil.ReverseProxy
	scimProxy            *httputil.ReverseProxy
	mux                  *http.ServeMux
}

func NewHandler(config Config, dependencies Dependencies) (http.Handler, error) {
	var publicOrigin *url.URL
	if config.PublicOrigin != "" {
		var err error
		publicOrigin, err = gatewayconfig.ParsePublicOrigin(config.PublicOrigin)
		if err != nil {
			return nil, err
		}
	}
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
	if dependencies.Identity == nil || dependencies.Agents == nil || dependencies.Execution == nil ||
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
		publicOrigin: publicOrigin, trustedProxies: append([]netip.Prefix(nil), config.TrustedProxies...),
		identity: dependencies.Identity, agents: dependencies.Agents, execution: dependencies.Execution, sessions: dependencies.Sessions,
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
		stateConnections: make(chan struct{}, 64),
		bridgeStreams:    make(chan struct{}, 64),
		mux:              http.NewServeMux(),
	}
	h.adminProxy = h.newProxy(consoleURL, "console_unavailable", "Admin Console is unavailable", nil)
	h.appProxy = h.newProxy(consoleURL, "console_unavailable", "Admin Console is unavailable", nil)
	h.workspaceBridgeProxy = h.newWorkspaceBridgeProxy(agentUIURL)
	h.scimProxy = h.newSCIMProxy(identityURL)
	h.routes()
	return h, nil
}

func (h *handler) routes() {
	h.mux.HandleFunc("GET /status", h.status)
	h.mux.HandleFunc("POST /api/session/login", telemetry.Handler(h.login))
	h.mux.HandleFunc("POST /api/session/login-methods", telemetry.Handler(h.loginMethods))
	h.mux.HandleFunc("POST /api/session/oidc/start", telemetry.Handler(h.startOIDCLogin))
	h.mux.HandleFunc("GET /api/session", telemetry.Handler(h.getSession))
	h.mux.HandleFunc("DELETE /api/session", telemetry.Handler(h.logout))
	h.mux.HandleFunc("GET /api/app/bootstrap", telemetry.Handler(h.workspaceBootstrap))
	h.mux.HandleFunc("GET /api/app/agents/{agent_id}/state", telemetry.Handler(h.getWorkspaceState))
	h.mux.HandleFunc("GET /api/app/agents/{agent_id}/state/watch", telemetry.Handler(h.watchWorkspaceState))
	h.mux.HandleFunc("/api/app/workspace/v1/{path...}", telemetry.Handler(h.workspaceBridgeAPI))
	for _, route := range []struct{ suffix, version string }{
		{"acp", "v1"}, {"v1/acp", "v1"}, {"v2/acp", "v2"},
	} {
		h.mux.HandleFunc("GET /api/app/agents/{agent_id}/"+route.suffix,
			telemetry.Handler(func(response http.ResponseWriter, request *http.Request) error {
				request.SetPathValue("acp_version", route.version)
				return h.workspaceACP(response, request)
			}))
		if route.version == "v1" {
			for _, method := range []string{http.MethodPost, http.MethodDelete} {
				h.mux.HandleFunc(method+" /api/app/agents/{agent_id}/"+route.suffix,
					telemetry.Handler(func(response http.ResponseWriter, request *http.Request) error {
						request.SetPathValue("acp_version", "v1")
						return h.workspaceACP(response, request)
					}))
			}
		}
	}
	h.mux.HandleFunc("/api/app/{path...}", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("GET /protocol/oidc/callback", telemetry.Handler(h.oidcCallback))
	h.mux.HandleFunc("/protocol/oidc", h.unknownIdentityProtocol)
	h.mux.HandleFunc("/protocol/oidc/{path...}", h.unknownIdentityProtocol)
	h.mux.Handle("/scim/v2", h.scimProxy)
	h.mux.Handle("/scim/v2/{path...}", h.scimProxy)
	h.mux.HandleFunc("/api/admin", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("/api/admin/{path...}", telemetry.Handler(h.admin))
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
	address := h.clientAddress(request)
	ctx := context.WithValue(request.Context(), clientAddressKey{}, address)
	*request = *request.WithContext(telemetry.WithClientAddress(ctx, address))
	stripForwardingHeaders(request.Header)
	stripBrowserCredentials(request)
	writer := &securityHeaderWriter{ResponseWriter: response, https: h.externalOrigin(request).Scheme == "https"}
	writer.applyTransportPolicy()
	h.mux.ServeHTTP(writer, request)
	if !writer.wroteHeader {
		// Handlers may return an empty response without explicitly committing it.
		writer.applyDefaults()
	}
}

func (h *handler) status(response http.ResponseWriter, request *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handler) login(response http.ResponseWriter, request *http.Request) error {
	var payload struct {
		OrganizationSlug string `json:"organization_slug"`
		Email            string `json:"email"`
		Password         string `json:"password"`
	}
	if !decodeJSON(response, request, maximumLoginBytes, &payload) {
		return nil
	}
	if strings.TrimSpace(payload.OrganizationSlug) == "" || strings.TrimSpace(payload.Email) == "" ||
		payload.Password == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required login field is empty")
		return nil
	}
	if !h.admitLogin(response, request, payload.OrganizationSlug, payload.Email) {
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.Login(ctx, identity.LoginInput{
		RequestID: h.newRequestID(), OrganizationSlug: strings.TrimSpace(payload.OrganizationSlug),
		Email: strings.TrimSpace(payload.Email), Password: payload.Password,
	})
	if err != nil {
		h.writeIdentityError(response, err)
		return err
	}
	if !result.Principal.Active {
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is inactive")
		return nil
	}
	if _, err := h.sessions.Establish(response, result.AccessToken, result.ExpiresAt); err != nil {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be established")
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, map[string]any{
		"principal": result.Principal, "expires_at": result.ExpiresAt,
	})
	return nil
}

func (h *handler) loginMethods(response http.ResponseWriter, request *http.Request) error {
	var payload struct {
		OrganizationSlug string `json:"organization_slug"`
	}
	if !decodeJSON(response, request, maximumLoginBytes, &payload) {
		return nil
	}
	organizationSlug := strings.TrimSpace(payload.OrganizationSlug)
	if organizationSlug == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Organization is required")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	methods, err := h.identity.ListLoginMethods(ctx, organizationSlug)
	if err != nil {
		h.writePublicOIDCError(response, err)
		return err
	}
	if methods == nil {
		methods = []identity.LoginMethod{}
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, map[string]any{"methods": methods})
	return nil
}

func (h *handler) startOIDCLogin(response http.ResponseWriter, request *http.Request) error {
	var payload struct {
		OrganizationSlug string `json:"organization_slug"`
		ProviderName     string `json:"provider_name"`
	}
	if !decodeJSON(response, request, maximumLoginBytes, &payload) {
		return nil
	}
	organizationSlug := strings.TrimSpace(payload.OrganizationSlug)
	providerName := strings.TrimSpace(payload.ProviderName)
	if organizationSlug == "" || providerName == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Organization and login method are required")
		return nil
	}
	if !h.admitLogin(response, request, organizationSlug, "oidc:"+providerName) {
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.StartOIDCLogin(ctx, identity.StartOIDCLoginInput{
		RequestID: h.newRequestID(), OrganizationSlug: organizationSlug, ProviderName: providerName,
	})
	if err != nil {
		h.writePublicOIDCError(response, err)
		return err
	}
	if err := h.sessions.BindOIDC(response, result.AuthorizationURL, result.ExpiresAt); err != nil {
		h.writePublicOIDCError(response, err)
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, result)
	return nil
}

func (h *handler) oidcCallback(response http.ResponseWriter, request *http.Request) error {
	response.Header().Set("Cache-Control", "no-store")
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		h.redirectOIDCFailure(response, request)
		return err
	}
	input := identity.OIDCCallbackInput{
		State: strings.TrimSpace(query.Get("state")), Code: strings.TrimSpace(query.Get("code")),
		AuthorizationError: strings.TrimSpace(query.Get("error")),
	}
	if input.State == "" || (input.Code == "") == (input.AuthorizationError == "") {
		h.redirectOIDCFailure(response, request)
		return nil
	}
	for _, name := range []string{"state", "code", "error"} {
		if len(query[name]) > 1 {
			h.redirectOIDCFailure(response, request)
			return nil
		}
	}
	if !h.sessions.MatchesOIDC(request, input.State) {
		h.redirectOIDCFailure(response, request)
		return nil
	}
	h.sessions.ClearOIDC(response)
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.CompleteOIDCLogin(ctx, input)
	if err != nil || result.AccessToken == "" || !result.Principal.Active {
		h.redirectOIDCFailure(response, request)
		return err
	}
	if _, err := h.sessions.Establish(response, result.AccessToken, result.ExpiresAt); err != nil {
		h.redirectOIDCFailure(response, request)
		return err
	}
	http.Redirect(response, request, "/", http.StatusSeeOther)
	return nil
}

func (*handler) redirectOIDCFailure(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	http.Redirect(response, request, "/?auth_error=oidc_login_failed", http.StatusSeeOther)
}

func (h *handler) getSession(response http.ResponseWriter, request *http.Request) error {
	_, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, map[string]any{"principal": principal})
	return nil
}

func (h *handler) logout(response http.ResponseWriter, request *http.Request) error {
	values, ok := h.sessions.Read(request)
	if !ok {
		h.sessions.Clear(response)
		response.WriteHeader(http.StatusNoContent)
		return nil
	}
	if !h.validCSRF(request, values) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	if _, err := h.identity.RevokeByAccessToken(ctx, values.AccessToken); err != nil {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be revoked")
		return err
	}
	h.sessions.Clear(response)
	response.WriteHeader(http.StatusNoContent)
	return nil
}

type workspacePrincipalResponse struct {
	UserID         string `json:"user_id"`
	OrganizationID string `json:"organization_id"`
	Administrator  bool   `json:"administrator"`
}

type workspaceAgentResponse struct {
	AgentID         string `json:"agent_id"`
	Name            string `json:"name"`
	LifecycleState  string `json:"lifecycle_state"`
	ActivationState string `json:"activation_state,omitempty"`
	RuntimeState    string `json:"runtime_state"`
}

type workspaceBootstrapResponse struct {
	Principal workspacePrincipalResponse `json:"principal"`
	Agents    []workspaceAgentResponse   `json:"agents"`
}

func (h *handler) workspaceBootstrap(response http.ResponseWriter, request *http.Request) error {
	response.Header().Set("Cache-Control", "no-store")
	_, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	agents, err := h.workspaceAgents(request.Context(), principal)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "workspace_unavailable", "Agent workspace is unavailable")
		return err
	}
	items := make([]workspaceAgentResponse, 0, len(agents))
	for _, agent := range agents {
		items = append(items, workspaceAgentResponse{
			AgentID: agent.AgentID, Name: agent.Name,
			LifecycleState: agent.LifecycleState, ActivationState: agent.ActivationState, RuntimeState: agent.RuntimeState,
		})
	}
	writeJSON(response, http.StatusOK, workspaceBootstrapResponse{
		Principal: workspacePrincipalResponse{
			UserID: principal.UserID, OrganizationID: principal.OrganizationID,
			Administrator: principal.Administrator(),
		},
		Agents: items,
	})
	return nil
}

func (h *handler) workspaceACP(response http.ResponseWriter, request *http.Request) error {
	upgrade := webSocketUpgrade(request)
	if !upgrade && request.PathValue("acp_version") != "v1" {
		writeError(response, http.StatusBadRequest, "invalid_request", "WebSocket upgrade is required")
		return nil
	}
	if (upgrade || len(request.Header.Values("Origin")) > 0) && !h.sameOrigin(request) {
		writeError(response, http.StatusForbidden, "forbidden", "ACP origin is not allowed")
		return nil
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
		return nil
	}
	values, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	if !upgrade && stateChanging(request.Method) && !h.validCSRF(request, values) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return nil
	}
	if upgrade {
		h.relayWorkspaceACP(response, request, values.AccessToken, principal)
	} else {
		h.relayWorkspaceHTTP(response, request, principal)
	}
	return nil
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
		target := "/workspace/"
		if request.URL.RawQuery != "" {
			target += "?" + request.URL.RawQuery
		}
		http.Redirect(response, request, target, http.StatusTemporaryRedirect)
		return
	}
	asset := strings.HasPrefix(request.URL.Path, "/workspace/assets/")
	var principal identity.Principal
	if !asset {
		response.Header().Set("Cache-Control", "private, no-store")
		var ok bool
		principal, ok = h.authenticateWorkspaceDocument(response, request)
		if !ok {
			return
		}
	}
	request.Header.Del("Cookie")
	request.Header.Del("Authorization")
	for _, header := range []string{
		HeaderOrganizationID, HeaderPrincipalID, HeaderUserID,
		HeaderMembershipID, HeaderAgentID, HeaderAdministrator,
		HeaderOrganizationSlug, HeaderOrganizationName,
	} {
		request.Header.Del(header)
	}
	if !asset {
		setWorkspacePrincipalHeaders(request.Header, principal)
	}
	h.workspaceBridgeProxy.ServeHTTP(response, request)
}

func (h *handler) authenticateWorkspaceDocument(response http.ResponseWriter, request *http.Request) (identity.Principal, bool) {
	values, ok := h.sessions.Read(request)
	if !ok {
		redirectWorkspaceLogin(response, request)
		return identity.Principal{}, false
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	profile, agent := callerSelection(request)
	principal, err := h.identity.Resolve(identity.WithResolution(ctx, profile, agent), values.AccessToken)
	if err != nil && !identity.IsCode(err, "unauthenticated") && !identity.IsCode(err, "inactive_principal") {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return identity.Principal{}, false
	}
	if err != nil || !principal.Active {
		h.sessions.Clear(response)
		redirectWorkspaceLogin(response, request)
		return identity.Principal{}, false
	}
	if principal.CallerContext == "" {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return identity.Principal{}, false
	}
	*request = *request.WithContext(identity.WithPrincipal(request.Context(), principal))
	return principal, true
}

func redirectWorkspaceLogin(response http.ResponseWriter, request *http.Request) {
	returnTo := "/workspace/"
	if validWorkspaceReturnPath(request.URL) {
		returnTo = request.URL.EscapedPath()
	}
	response.Header().Set("Cache-Control", "private, no-store")
	http.Redirect(response, request, "/?return_to="+url.QueryEscape(returnTo), http.StatusSeeOther)
}

func validWorkspaceReturnPath(destination *url.URL) bool {
	if destination.RawQuery != "" || destination.ForceQuery || destination.Fragment != "" {
		return false
	}
	path := destination.EscapedPath()
	if path == "/workspace/" {
		return true
	}
	// Split before decoding so an encoded separator remains inside its ID.
	parts := strings.Split(path, "/")
	if len(parts) != 4 && len(parts) != 5 || parts[0] != "" || parts[1] != "workspace" {
		return false
	}
	agent, err := url.PathUnescape(parts[2])
	if err != nil || !validWorkspaceReturnID(agent) || agent == "assets" {
		return false
	}
	if len(parts) == 4 {
		return parts[3] == ""
	}
	sessionID, err := url.PathUnescape(parts[4])
	return parts[3] == "sessions" && err == nil && validWorkspaceReturnID(sessionID)
}

func validWorkspaceReturnID(value string) bool {
	if value == "" || len(value) > 200 || !utf8.ValidString(value) ||
		strings.TrimSpace(value) != value || strings.Trim(value, "\ufeff") != value ||
		value == "." || value == ".." {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
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

func (h *handler) admin(response http.ResponseWriter, request *http.Request) error {
	values, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	if !principal.Administrator() {
		writeError(response, http.StatusForbidden, "forbidden", "Administrator access is required")
		return nil
	}
	if stateChanging(request.Method) && !h.validCSRF(request, values) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return nil
	}
	if !restoreNetworkPrincipalPrecondition(request, principal) {
		writeError(response, http.StatusConflict, "principal_changed", "Account changed. Reload this page before updating network policy.")
		return nil
	}
	setPrincipalHeaders(request.Header, principal)
	request.Header.Del("Cookie")
	request.Header.Del("Authorization")
	timeout := h.requestTimeout
	if isAgentEventWatch(request) {
		timeout = h.streamLease
	}
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()
	request = request.WithContext(ctx)
	h.adminProxy.ServeHTTP(response, request)
	return nil
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
) (session.Values, identity.Principal, error) {
	response.Header().Set("Cache-Control", "no-store")
	values, ok := h.sessions.Read(request)
	if !ok {
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Login is required")
		return session.Values{}, identity.Principal{}, errInvalidSession
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	profile, agent := callerSelection(request)
	principal, err := h.identity.Resolve(identity.WithResolution(ctx, profile, agent), values.AccessToken)
	if err != nil && !identity.IsCode(err, "unauthenticated") && !identity.IsCode(err, "inactive_principal") {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return session.Values{}, identity.Principal{}, err
	}
	if err != nil || !principal.Active {
		h.sessions.Clear(response)
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is invalid or expired")
		return session.Values{}, identity.Principal{}, errInvalidSession
	}
	if principal.CallerContext == "" {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return session.Values{}, identity.Principal{}, errors.New("identity omitted caller context")
	}
	*request = *request.WithContext(identity.WithPrincipal(request.Context(), principal))
	return values, principal, nil
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
		h.forwardingHeaders(request.Out.Header, request.In)
		request.Out.Host = target.Host
		request.Out.Header.Del("Cookie")
		request.Out.Header.Del("Authorization")
		identity.ForwardCallerContext(request.In.Context(), request.Out.Header)
	}
	proxy.ModifyResponse = stripCredentialResponse
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
		h.forwardingHeaders(request.Out.Header, request.In)
		request.Out.Host = target.Host
		request.Out.Header.Del("Cookie")
	}
	proxy.ModifyResponse = stripCredentialResponse
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

func parseServiceURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("invalid service URL")
	}
	return parsed, nil
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
	if h.loginAdmission.Allow(clientAddress(request), organization, account) {
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

func setWorkspacePrincipalHeaders(header http.Header, principal identity.Principal) {
	header.Set(HeaderOrganizationID, principal.OrganizationID)
	header.Set(HeaderPrincipalID, principal.UserID)
	header.Set(HeaderUserID, principal.UserID)
	header.Set(HeaderMembershipID, principal.MembershipID)
	header.Set(HeaderOrganizationSlug, base64.RawURLEncoding.EncodeToString([]byte(principal.OrganizationSlug)))
	header.Set(HeaderOrganizationName, base64.RawURLEncoding.EncodeToString([]byte(principal.OrganizationName)))
	if principal.Administrator() {
		header.Set(HeaderAdministrator, "true")
	} else {
		header.Set(HeaderAdministrator, "false")
	}
}

func stateChanging(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
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
