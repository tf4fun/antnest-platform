package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/serviceauth"
)

// Security is mandatory for every production handler, including composed
// learning routes. A workload identity is never an end-user identity.
type Security struct {
	Authentication *serviceauth.Receiver
	CallerContext  *callercontext.Verifier
}

func (security Security) valid() bool {
	return security.Authentication != nil && security.CallerContext != nil
}

type workloadContextKey struct{}

type authenticatedMux struct {
	mux      *http.ServeMux
	security Security
}

func (boundary *authenticatedMux) Handler(r *http.Request) (http.Handler, string) {
	return boundary.mux.Handler(r)
}

func (security Security) guardMux(mux *http.ServeMux) http.Handler {
	return &authenticatedMux{mux: mux, security: security}
}

func (boundary *authenticatedMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	original := r
	defer func() { original.Pattern = r.Pattern }()
	mux, security := boundary.mux, boundary.security
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
		(r.URL.EscapedPath() == "/status" || r.URL.EscapedPath() == "/rpc/agent-controller/status") {
		mux.ServeHTTP(w, r)
		return
	}
	if _, trusted := r.Context().Value(workloadContextKey{}).(string); !trusted {
		caller, err := security.Authentication.Authorize(r, []string{"admin-console", "edge-gateway", "agent-ui", "agent-acp-service"})
		if err != nil {
			writeAuthenticationError(w, err)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), workloadContextKey{}, caller))
	}
	mux.ServeHTTP(w, r)
}

func (security Security) guardRoute(pattern string, next http.Handler) http.Handler {
	if pattern == "GET /status" || pattern == "GET /rpc/agent-controller/status" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caller, _ := r.Context().Value(workloadContextKey{}).(string)
		allowed := []string{"admin-console"}
		operation := pattern == "GET /internal/agents/{agent_id}/skill-learning-policy"
		if operation {
			allowed = []string{"agent-acp-service"}
		} else if pattern == "POST /rpc/agent-controller/list-workspace-agents" {
			allowed = []string{"edge-gateway", "agent-ui"}
		}
		if !slices.Contains(allowed, caller) {
			writeError(w, http.StatusForbidden, "caller_not_allowed", "Caller cannot use this route", false)
			return
		}
		query, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Request query is invalid", false)
			return
		}
		for _, values := range query {
			if len(values) != 1 {
				writeError(w, http.StatusBadRequest, "invalid_request", "Repeated query fields are invalid", false)
				return
			}
		}
		var object map[string]json.RawMessage
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			if r.URL.RawQuery != "" {
				writeError(w, http.StatusBadRequest, "invalid_request", "JSON mutations do not accept query fields", false)
				return
			}
			var ok bool
			object, ok = authenticationBody(w, r)
			if !ok {
				return
			}
		}
		if operation {
			// The learning policy service resolves the persisted Agent, exact
			// owner, access revision and live owner membership before returning
			// policy. ACP cannot manufacture a user delegation with body hints.
			next.ServeHTTP(w, stripAuthority(r))
			return
		}
		tokens := headerValues(r.Header, callercontext.Header)
		if len(tokens) != 1 {
			code := "caller_context_invalid"
			if len(tokens) == 0 {
				code = "caller_context_required"
			}
			writeError(w, http.StatusUnauthorized, code, "Verified caller context is required", false)
			return
		}
		var agent *string
		if id := r.PathValue("agent_id"); id != "" {
			agent = &id
		} else if pattern == "POST /rpc/agent-controller/set-agent-authorization" {
			if id, ok := objectString(object, "agent_id"); ok && id != "" {
				agent = &id
			}
		}
		claims, err := security.CallerContext.Verify(r.Context(), tokens[0], callercontext.Expected{Consumer: "agent-controller", Agent: agent, Tolerance: 30})
		if err != nil {
			if errors.Is(err, callercontext.ErrDependency) {
				writeError(w, http.StatusServiceUnavailable, "identity_dependency_unavailable", "Identity authorization dependency is unavailable", true)
			} else {
				writeError(w, http.StatusUnauthorized, "caller_context_invalid", "Caller context verification failed", false)
			}
			return
		}
		if caller == "admin-console" && claims.SystemRole != "admin" && claims.OrganizationRole != "admin" {
			writeError(w, http.StatusForbidden, "forbidden", "Administrator access is required", false)
			return
		}
		for _, key := range []string{"organization_id", "actor_principal_id", "principal_id"} {
			expected, code := claims.Subject, "actor_mismatch"
			if key == "organization_id" {
				expected, code = claims.Organization, "organization_mismatch"
			}
			if actual, ok := objectString(object, key); ok && actual != expected {
				if actual == "" || strings.TrimSpace(actual) != actual {
					writeError(w, http.StatusBadRequest, "invalid_request", "Request scope is malformed", false)
					return
				}
				writeError(w, http.StatusForbidden, code, "Request scope differs from verified caller", false)
				return
			}
			for _, actual := range query[key] {
				if actual == "" || strings.TrimSpace(actual) != actual {
					writeError(w, http.StatusBadRequest, "invalid_request", "Request scope is malformed", false)
					return
				}
				if actual != expected {
					writeError(w, http.StatusForbidden, code, "Request scope differs from verified caller", false)
					return
				}
			}
		}
		r = stripAuthority(r.WithContext(callercontext.WithToken(r.Context(), tokens[0])))
		next.ServeHTTP(w, r)
	})
}

func headerValues(headers http.Header, name string) []string {
	var values []string
	for key, entries := range headers {
		if strings.EqualFold(key, name) {
			values = append(values, entries...)
		}
	}
	return values
}

func objectString(object map[string]json.RawMessage, key string) (string, bool) {
	raw, present := object[key]
	if !present {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func authenticationBody(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	media := headerValues(r.Header, "Content-Type")
	encodings := headerValues(r.Header, "Content-Encoding")
	if len(media) != 1 || len(encodings) > 1 || len(encodings) == 1 && encodings[0] != "identity" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "UTF-8 application/json is required", false)
		return nil, false
	}
	typeName, parameters, err := mime.ParseMediaType(media[0])
	if err != nil || typeName != "application/json" || len(parameters) > 1 ||
		len(parameters) == 1 && !strings.EqualFold(parameters["charset"], "utf-8") {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "UTF-8 application/json is required", false)
		return nil, false
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maximumRequestBytes))
	if err != nil {
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "Request exceeds the body limit", false)
		} else {
			writeError(w, http.StatusBadRequest, "invalid_request", "Request body is invalid", false)
		}
		return nil, false
	}
	var object map[string]json.RawMessage
	if serviceauth.DecodeObject(raw, &object) != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Request body is invalid", false)
		return nil, false
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	return object, true
}

func stripAuthority(request *http.Request) *http.Request {
	copyRequest := request.Clone(request.Context())
	for name := range copyRequest.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-antnest-") || strings.EqualFold(name, "Cookie") ||
			strings.EqualFold(name, "Authorization") || strings.EqualFold(name, callercontext.Header) || strings.EqualFold(name, serviceauth.Header) {
			delete(copyRequest.Header, name)
		}
	}
	return copyRequest
}

func writeAuthenticationError(w http.ResponseWriter, err error) {
	var failure *serviceauth.Failure
	if !errors.As(err, &failure) {
		failure = serviceauth.Unauthenticated()
	}
	if failure.Challenge != "" {
		w.Header().Set("WWW-Authenticate", failure.Challenge)
	}
	writeError(w, failure.Status, failure.Code, "Service authentication failed", false)
}
