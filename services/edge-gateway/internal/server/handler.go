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
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/browserstream"
	gatewayconfig "github.com/tf4fun/antnest-platform/services/edge-gateway/internal/config"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

const (
	HeaderUserID              = "X-Antnest-User-ID"
	HeaderOrganizationID      = "X-Antnest-Organization-ID"
	HeaderOrganizationSlug    = "X-Antnest-Organization-Slug"
	HeaderOrganizationName    = "X-Antnest-Organization-Name"
	HeaderMembershipID        = "X-Antnest-Membership-ID"
	HeaderSystemRole          = "X-Antnest-System-Role"
	HeaderOrganizationRole    = "X-Antnest-Organization-Role"
	HeaderAdministrator       = "X-Antnest-Administrator"
	HeaderPrincipalID         = "X-Antnest-Principal-ID"
	HeaderAgentID             = "X-Antnest-Agent-ID"
	HeaderTraceID             = "X-Antnest-Trace-ID"
	HeaderAgentAccessSubject  = "X-Antnest-Agent-Access-Subject"
	maximumLoginBytes         = 64 << 10
	defaultStreamLease        = 5 * time.Minute
	defaultLoginWindow        = 5 * time.Minute
	defaultLoginSourceMax     = 30
	defaultLoginAccountMax    = 10
	defaultLoginMaxKeys       = 65536
	defaultOIDCStartSourceMax = 30
)

var errInvalidSession = errors.New("browser session is invalid or missing")

type IdentityService interface {
	Login(context.Context, identity.LoginInput) (identity.LoginResult, error)
	ListLoginMethods(context.Context, string) ([]identity.LoginMethod, error)
	StartOIDCLogin(context.Context, identity.StartOIDCLoginInput) (identity.StartOIDCLoginResult, error)
	CompleteOIDCLogin(context.Context, identity.OIDCCallbackInput) (identity.OIDCCallbackResult, error)
	Resolve(context.Context, string) (identity.Principal, error)
	RevokeByAccessToken(context.Context, string) (identity.RevokeStatus, error)
	CurrentAccount(context.Context) (identity.CurrentAccount, error)
	TouchSession(context.Context) (identity.SessionMetadata, error)
	ChangePassword(context.Context, identity.PasswordInput) (identity.LoginResult, error)
	ListSessions(context.Context, identity.SessionListInput) (identity.SessionPage, error)
	RevokeSessions(context.Context, identity.SessionRevokeInput) (identity.SessionRevokeResult, error)
	ListExternalIdentities(context.Context, identity.ExternalIdentityListInput) (identity.ExternalIdentityPage, error)
	UnbindExternalIdentity(context.Context, identity.ExternalIdentityUnbindInput) (identity.SessionRevokeResult, error)
	AcknowledgeExternalIdentityNotices(context.Context, identity.ExternalIdentityAcknowledgeInput) (identity.ExternalIdentityAcknowledgeResult, error)
}

type Config struct {
	AllowOriginlessMutations bool
	PublicOrigin             string
	TrustedProxies           []netip.Prefix
	AdminConsoleURL          string
	AgentUIURL               string
	IdentityURL              string
	RequestTimeout           time.Duration
	StreamLease              time.Duration
	LoginWindow              time.Duration
	LoginSourceMax           int
	LoginAccountMax          int
	LoginMaxKeys             int
	OIDCStartSourceMax       int
	Now                      func() time.Time
	NewRequestID             func() string
}

type Dependencies struct {
	Identity       IdentityService
	Sessions       *session.Manager
	HTTPClient     *http.Client
	Logger         *slog.Logger
	BrowserStreams *browserstream.Registry
}

type handler struct {
	allowOriginlessMutations bool
	publicOrigin             *url.URL
	trustedProxies           []netip.Prefix
	identity                 IdentityService
	sessions                 *session.Manager
	requestTimeout           time.Duration
	streamLease              time.Duration
	maximumSessionStale      time.Duration
	browserStreams           *browserstream.Registry
	loginWindow              time.Duration
	loginAdmission           *loginAdmission
	newRequestID             func() string
	now                      func() time.Time
	httpClient               *http.Client
	logger                   *slog.Logger
	consoleURL               *url.URL
	agentUIURL               *url.URL
	bridgeStreams            chan struct{}
	adminProxy               *httputil.ReverseProxy
	appProxy                 *httputil.ReverseProxy
	workspaceBridgeProxy     *httputil.ReverseProxy
	scimProxy                *httputil.ReverseProxy
	mux                      *http.ServeMux
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
	identityURL, err := parseServiceURL(config.IdentityURL)
	if err != nil {
		return nil, fmt.Errorf("identity service URL is invalid")
	}
	if dependencies.Identity == nil ||
		dependencies.Sessions == nil || dependencies.HTTPClient == nil {
		return nil, fmt.Errorf("gateway dependencies are incomplete")
	}
	if dependencies.Logger == nil {
		dependencies.Logger = slog.Default()
	}
	if dependencies.BrowserStreams == nil {
		dependencies.BrowserStreams = browserstream.NewRegistry()
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
	if config.LoginMaxKeys <= 0 {
		config.LoginMaxKeys = defaultLoginMaxKeys
	}
	if config.OIDCStartSourceMax <= 0 {
		config.OIDCStartSourceMax = defaultOIDCStartSourceMax
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewRequestID == nil {
		config.NewRequestID = randomRequestID
	}
	observeAdmission, err := newLoginAdmissionRecorder()
	if err != nil {
		return nil, fmt.Errorf("create login admission counter: %w", err)
	}
	h := &handler{
		allowOriginlessMutations: config.AllowOriginlessMutations,
		publicOrigin:             publicOrigin, trustedProxies: append([]netip.Prefix(nil), config.TrustedProxies...),
		identity: dependencies.Identity, sessions: dependencies.Sessions,
		requestTimeout: config.RequestTimeout, streamLease: config.StreamLease,
		maximumSessionStale: browserstream.DefaultMaximumStale, browserStreams: dependencies.BrowserStreams,
		loginWindow: config.LoginWindow,
		loginAdmission: newLoginAdmission(loginAdmissionConfig{
			Window: config.LoginWindow, SourceLimit: config.LoginSourceMax,
			AccountLimit: config.LoginAccountMax, OIDCSourceLimit: config.OIDCStartSourceMax,
			MaxKeys: config.LoginMaxKeys, Now: config.Now, Observe: observeAdmission,
		}),
		newRequestID: config.NewRequestID,
		now:          config.Now,
		httpClient:   dependencies.HTTPClient, logger: dependencies.Logger,
		consoleURL: consoleURL, agentUIURL: agentUIURL,
		bridgeStreams: make(chan struct{}, 64),
		mux:           http.NewServeMux(),
	}
	h.adminProxy = h.newConsoleProxy(consoleURL, true)
	h.appProxy = h.newConsoleProxy(consoleURL, false)
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
	h.mux.HandleFunc("GET /api/session/account", telemetry.Handler(h.getBrowserAccount))
	h.mux.HandleFunc("POST /api/session/activity", telemetry.Handler(h.touchBrowserSession))
	h.mux.HandleFunc("POST /api/session/password", telemetry.Handler(h.changeBrowserPassword))
	h.mux.HandleFunc("GET /api/session/sessions", telemetry.Handler(h.listBrowserSessions))
	h.mux.HandleFunc("POST /api/session/sessions/revoke", telemetry.Handler(h.revokeBrowserSessions))
	h.mux.HandleFunc("GET /api/session/external-identities", telemetry.Handler(h.listBrowserExternalIdentities))
	h.mux.HandleFunc("DELETE /api/session/external-identities/{binding_id}", telemetry.Handler(h.unbindBrowserExternalIdentity))
	h.mux.HandleFunc("POST /api/session/external-identities/notices/acknowledge", telemetry.Handler(h.acknowledgeBrowserExternalIdentityNotices))
	h.mux.HandleFunc("/api/app/workspace/v1/{path...}", telemetry.Handler(h.workspaceBridgeAPI))
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
	if strings.HasPrefix(request.URL.Path, "/api/") && !h.admitOrigin(request) {
		writeError(writer, http.StatusForbidden, "forbidden", "Request origin is not allowed")
		return
	}
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
	if !h.admitPasswordLogin(response, request, payload.OrganizationSlug, payload.Email) {
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.Login(ctx, identity.LoginInput{
		RequestID: h.newRequestID(), OrganizationSlug: strings.TrimSpace(payload.OrganizationSlug),
		Email: strings.TrimSpace(payload.Email), Password: payload.Password,
		UserAgentHint: browserUserAgent(request),
	})
	if err != nil {
		h.writeIdentityError(response, err)
		return err
	}
	if !result.Principal.Active {
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is inactive")
		return nil
	}
	if ctx.Err() != nil || !h.liveBrowserMetadata(result.SessionMetadata()) {
		return h.writeBrowserIdentityError(response, fmt.Errorf("login returned invalid session metadata"), false)
	}
	if _, err := h.sessions.Establish(response, result.AccessToken, result.TokenID, result.ExpiresAt); err != nil {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be established")
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, browserSessionJSON(result.Principal, result.SessionMetadata()))
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
	if !h.admitOIDCStart(response, request) {
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.StartOIDCLogin(ctx, identity.StartOIDCLoginInput{
		RequestID: h.newRequestID(), OrganizationSlug: organizationSlug, ProviderName: providerName,
		UserAgentHint: browserUserAgent(request),
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
	if err != nil || ctx.Err() != nil || result.AccessToken == "" || !result.Principal.Active || !h.liveBrowserMetadata(result.SessionMetadata()) {
		h.redirectOIDCFailure(response, request)
		return err
	}
	if _, err := h.sessions.Establish(response, result.AccessToken, result.TokenID, result.ExpiresAt); err != nil {
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
	writeJSON(response, http.StatusOK, browserSessionJSON(principal, principal.SessionMetadata()))
	return nil
}

func (h *handler) logout(response http.ResponseWriter, request *http.Request) error {
	response.Header().Set("Cache-Control", "no-store")
	_, status := h.sessions.Read(request)
	if status == session.Absent {
		h.sessions.Clear(response)
		response.WriteHeader(http.StatusNoContent)
		return nil
	}
	values, principal, err := h.authenticateSession(response, request, true)
	if err != nil {
		return err
	}
	if !h.validCSRF(request, principal.SessionID) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	revoked, err := h.identity.RevokeByAccessToken(ctx, values.AccessToken)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be revoked")
		return err
	}
	h.sessions.Clear(response)
	if revoked == identity.RevokeStatusAlreadyInvalid {
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is invalid or expired")
		return nil
	}
	response.WriteHeader(http.StatusNoContent)
	return nil
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
	if !asset {
		response.Header().Set("Cache-Control", "private, no-store")
		if _, ok := h.authenticateWorkspaceDocument(response, request); !ok {
			return
		}
	}
	h.workspaceBridgeProxy.ServeHTTP(response, request)
}

func (h *handler) authenticateWorkspaceDocument(response http.ResponseWriter, request *http.Request) (identity.Principal, bool) {
	values, status := h.sessions.Read(request)
	if status != session.Valid {
		redirectWorkspaceLogin(response, request)
		return identity.Principal{}, false
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	profile, agent := callerSelection(request)
	principal, err := h.identity.Resolve(identity.WithResolution(ctx, profile, agent), values.AccessToken)
	err = h.browserAdmissionError(ctx, principal, err)
	if err != nil && !identity.IsCode(err, "unauthenticated") && !identity.IsCode(err, "inactive_principal") {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return identity.Principal{}, false
	}
	if err != nil || !principal.Active {
		redirectWorkspaceLogin(response, request)
		return identity.Principal{}, false
	}
	if principal.CallerContext == "" || !callercontext.ValidID(principal.SessionID) {
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

func (h *handler) admin(response http.ResponseWriter, request *http.Request) error {
	values, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	if !principal.Administrator() {
		writeError(response, http.StatusForbidden, "forbidden", "Administrator access is required")
		return nil
	}
	if stateChanging(request.Method) && !h.validCSRF(request, principal.SessionID) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return nil
	}
	if !validateNetworkPrincipalPrecondition(request, principal) {
		writeError(response, http.StatusConflict, "principal_changed", "Account changed. Reload this page before updating network policy.")
		return nil
	}
	if isAgentEventWatch(request) {
		response, request, finish, err := h.guardBrowserStream(response, request, values.AccessToken, principal)
		if err != nil {
			return err
		}
		defer finish()
		h.adminProxy.ServeHTTP(response, request)
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
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
	h.appProxy.ServeHTTP(response, request)
}

func (h *handler) authenticate(
	response http.ResponseWriter,
	request *http.Request,
) (session.Values, identity.Principal, error) {
	return h.authenticateSession(response, request, false)
}

func (h *handler) authenticateSession(response http.ResponseWriter, request *http.Request, clearInvalid bool) (session.Values, identity.Principal, error) {
	response.Header().Set("Cache-Control", "no-store")
	values, status := h.sessions.Read(request)
	if status != session.Valid {
		if clearInvalid && status == session.Invalid {
			h.sessions.Clear(response)
		}
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Login is required")
		return session.Values{}, identity.Principal{}, errInvalidSession
	}
	stream := browserStreamRequest(request)
	budget := h.requestTimeout
	if stream {
		budget = min(budget, h.maximumSessionStale/3)
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(request.Context(), budget)
	defer cancel()
	profile, agent := callerSelection(request)
	principal, err := h.identity.Resolve(identity.WithResolution(ctx, profile, agent), values.AccessToken)
	err = h.browserAdmissionError(ctx, principal, err)
	if err == nil && stream && time.Since(started) > browserstream.Interval(h.maximumSessionStale, principal.ActivityIntervalMS) {
		err = browserstream.ErrUnavailable
	}
	if err != nil && !identity.IsCode(err, "unauthenticated") && !identity.IsCode(err, "inactive_principal") {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return session.Values{}, identity.Principal{}, err
	}
	if err != nil || !principal.Active {
		if clearInvalid {
			h.sessions.Clear(response)
		}
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is invalid or expired")
		return session.Values{}, identity.Principal{}, errInvalidSession
	}
	if principal.CallerContext == "" || !callercontext.ValidID(principal.SessionID) {
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Session could not be verified")
		return session.Values{}, identity.Principal{}, errors.New("identity omitted caller context")
	}
	requestCtx := identity.WithPrincipal(request.Context(), principal)
	if stream {
		requestCtx = context.WithValue(requestCtx, browserStreamStartKey{}, started)
	}
	*request = *request.WithContext(requestCtx)
	return values, principal, nil
}

func (h *handler) newConsoleProxy(target *url.URL, authenticated bool) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{}
	proxy.Rewrite = func(request *httputil.ProxyRequest) {
		request.SetURL(target)
		headers := consoleHeaders(request, authenticated)
		h.forwardingHeaders(headers, request.In)
		request.Out.Host = target.Host
	}
	proxy.ModifyResponse = stripCredentialResponse
	proxy.Transport = h.httpClient.Transport
	if proxy.Transport == nil {
		proxy.Transport = http.DefaultTransport
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, err error) {
		h.logger.ErrorContext(request.Context(), "Gateway proxy failed", "error_class", "upstream_unavailable")
		writeError(response, http.StatusServiceUnavailable, "console_unavailable", "Admin Console is unavailable")
	}
	return proxy
}

func (h *handler) newSCIMProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{}
	proxy.Rewrite = func(request *httputil.ProxyRequest) {
		request.SetURL(target)
		headers := forwardHeaders(request, scimRequestHeaders)
		h.forwardingHeaders(headers, request.In)
		request.Out.Host = target.Host
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
	if writePasswordAdmissionError(response, err) {
		return
	}
	switch {
	case identity.IsCode(err, "unauthenticated"), identity.IsCode(err, "inactive_principal"):
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Email or password is incorrect")
	case identity.IsCode(err, "forbidden"):
		writeError(response, http.StatusForbidden, "forbidden", "Login is not allowed")
	default:
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Identity Service is unavailable")
	}
}

func (h *handler) admitPasswordLogin(
	response http.ResponseWriter, request *http.Request, organization, account string,
) bool {
	if h.loginAdmission.AllowPassword(clientAddress(request), organization, account) {
		return true
	}
	h.writeLoginAdmissionRefusal(response)
	return false
}

func (h *handler) admitOIDCStart(response http.ResponseWriter, request *http.Request) bool {
	if h.loginAdmission.AllowOIDCStart(clientAddress(request)) {
		return true
	}
	h.writeLoginAdmissionRefusal(response)
	return false
}

func (h *handler) writeLoginAdmissionRefusal(response http.ResponseWriter) {
	seconds := int64(h.loginWindow / time.Second)
	if h.loginWindow%time.Second != 0 {
		seconds++
	}
	response.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	writeError(response, http.StatusTooManyRequests, "login_rate_limited", "Too many login attempts")
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
