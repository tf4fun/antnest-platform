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

	"soft/antnest-platform/services/edge-gateway/internal/identity"
	"soft/antnest-platform/services/edge-gateway/internal/session"
)

const (
	HeaderUserID           = "X-Antnest-User-ID"
	HeaderOrganizationID   = "X-Antnest-Organization-ID"
	HeaderMembershipID     = "X-Antnest-Membership-ID"
	HeaderSystemRole       = "X-Antnest-System-Role"
	HeaderOrganizationRole = "X-Antnest-Organization-Role"
	HeaderTraceID          = "X-Antnest-Trace-ID"
	maximumLoginBytes      = 64 << 10
	defaultStreamLease     = 5 * time.Minute
	defaultLoginWindow     = 5 * time.Minute
	defaultLoginSourceMax  = 30
	defaultLoginAccountMax = 10
	defaultLoginMaxKeys    = 4096
)

var trustedHeaders = []string{
	HeaderUserID, HeaderOrganizationID, HeaderMembershipID,
	HeaderSystemRole, HeaderOrganizationRole,
}

type IdentityService interface {
	Login(context.Context, identity.LoginInput) (identity.LoginResult, error)
	Resolve(context.Context, string) (identity.Principal, error)
	RevokeByAccessToken(context.Context, string) (identity.RevokeStatus, error)
	Ready(context.Context) error
}

type Config struct {
	AdminConsoleURL string
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
	Sessions   *session.Manager
	HTTPClient *http.Client
	Logger     *slog.Logger
}

type handler struct {
	identity       IdentityService
	sessions       *session.Manager
	requestTimeout time.Duration
	streamLease    time.Duration
	loginWindow    time.Duration
	loginAdmission *loginAdmission
	newRequestID   func() string
	httpClient     *http.Client
	logger         *slog.Logger
	consoleURL     *url.URL
	adminProxy     *httputil.ReverseProxy
	appProxy       *httputil.ReverseProxy
	mux            *http.ServeMux
}

func NewHandler(config Config, dependencies Dependencies) (http.Handler, error) {
	consoleURL, err := url.Parse(strings.TrimSpace(config.AdminConsoleURL))
	if err != nil || consoleURL.Scheme == "" || consoleURL.Host == "" {
		return nil, fmt.Errorf("admin console URL is invalid")
	}
	if dependencies.Identity == nil || dependencies.Sessions == nil || dependencies.HTTPClient == nil {
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
		identity: dependencies.Identity, sessions: dependencies.Sessions,
		requestTimeout: config.RequestTimeout, streamLease: config.StreamLease,
		loginWindow: config.LoginWindow,
		loginAdmission: newLoginAdmission(loginAdmissionConfig{
			Window: config.LoginWindow, SourceLimit: config.LoginSourceMax,
			AccountLimit: config.LoginAccountMax, MaxKeys: defaultLoginMaxKeys, Now: config.Now,
		}),
		newRequestID: config.NewRequestID,
		httpClient:   dependencies.HTTPClient, logger: dependencies.Logger, consoleURL: consoleURL,
		mux: http.NewServeMux(),
	}
	h.adminProxy = h.newProxy("console_unavailable")
	h.appProxy = h.newProxy("console_unavailable")
	h.routes()
	return h, nil
}

func (h *handler) routes() {
	h.mux.HandleFunc("GET /status", h.status)
	h.mux.HandleFunc("POST /api/session/login", h.login)
	h.mux.HandleFunc("GET /api/session", h.getSession)
	h.mux.HandleFunc("DELETE /api/session", h.logout)
	for _, prefix := range []string{"/protocol/oidc", "/scim/v2"} {
		h.mux.HandleFunc(prefix, h.protocolUnavailable)
		h.mux.HandleFunc(prefix+"/{path...}", h.protocolUnavailable)
	}
	h.mux.HandleFunc("/api/admin", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("/api/admin/{path...}", h.admin)
	h.mux.HandleFunc("/api/{path...}", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("/{path...}", h.application)
}

func (*handler) protocolUnavailable(response http.ResponseWriter, _ *http.Request) {
	writeError(response, http.StatusServiceUnavailable,
		"protocol_unavailable", "Identity protocol endpoint is not available")
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
	if err := h.identity.Ready(ctx); err != nil || h.consoleReady(ctx) != nil {
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
	if !h.loginAdmission.Allow(
		requestSource(request), payload.OrganizationSlug, payload.Email,
	) {
		response.Header().Set("Retry-After", fmt.Sprintf("%.0f", h.loginWindow.Seconds()))
		writeError(response, http.StatusTooManyRequests, "login_rate_limited", "Too many login attempts")
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
	values, ok := h.sessions.Read(request)
	if !ok {
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Login is required")
		return session.Values{}, identity.Principal{}, false
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	principal, err := h.identity.Resolve(ctx, values.AccessToken)
	if err != nil || !principal.Active {
		h.sessions.Clear(response)
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is invalid or expired")
		return session.Values{}, identity.Principal{}, false
	}
	return values, principal, true
}

func (h *handler) newProxy(errorCode string) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{}
	proxy.Rewrite = func(request *httputil.ProxyRequest) {
		request.SetURL(h.consoleURL)
		request.SetXForwarded()
		request.Out.Host = h.consoleURL.Host
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
		h.logger.ErrorContext(request.Context(), "Admin Console proxy failed", "error_class", "upstream_unavailable")
		writeError(response, http.StatusServiceUnavailable, errorCode, "Admin Console is unavailable")
	}
	return proxy
}

func (h *handler) consoleReady(ctx context.Context) error {
	target := h.consoleURL.ResolveReference(&url.URL{Path: "/status"})
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
		return fmt.Errorf("admin console status %d", response.StatusCode)
	}
	return nil
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
