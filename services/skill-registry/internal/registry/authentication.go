package registry

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/serviceauth"
)

type Security struct {
	Authentication *serviceauth.Receiver
	CallerContext  *callercontext.Verifier
}

type workloadKey struct{}
type claimsKey struct{}
type authenticatedMux struct {
	mux      *http.ServeMux
	security Security
}

func (m *authenticatedMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	original := r
	_, r.Pattern = m.mux.Handler(r)
	defer func() { original.Pattern = r.Pattern }()
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && r.URL.EscapedPath() == "/status" {
		m.mux.ServeHTTP(w, r)
		return
	}
	caller, err := m.security.Authentication.Authorize(r, []string{"admin-console", "agent-controller", "runtime-controller", "agent-acp-service"})
	if err != nil {
		writeAuthenticationError(w, err)
		return
	}
	m.mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workloadKey{}, caller)))
}

func (h *Handler) auth(allowed []string, jsonBody bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller, _ := r.Context().Value(workloadKey{}).(string)
		if !slices.Contains(allowed, caller) {
			writeBoundaryError(w, 403, "caller_not_allowed", "Caller cannot use this route", false)
			return
		}
		query, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeBoundaryError(w, 400, "invalid_request", "Request query is malformed", false)
			return
		}
		for _, values := range query {
			if len(values) != 1 {
				writeBoundaryError(w, 400, "invalid_request", "Repeated query fields are invalid", false)
				return
			}
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.URL.RawQuery != "" {
			writeBoundaryError(w, 400, "invalid_request", "Mutations do not accept query fields", false)
			return
		}
		if caller == "admin-console" {
			tokens := headerValues(r.Header, callercontext.Header)
			if len(tokens) != 1 {
				code := "caller_context_invalid"
				if len(tokens) == 0 {
					code = "caller_context_required"
				}
				writeBoundaryError(w, 401, code, "Verified caller context is required", false)
				return
			}
			claims, err := h.security.CallerContext.Verify(r.Context(), tokens[0], callercontext.Expected{Consumer: "skill-registry", Tolerance: 30})
			if err != nil {
				if errors.Is(err, callercontext.ErrDependency) {
					writeBoundaryError(w, 503, "identity_dependency_unavailable", "Identity authorization dependency is unavailable", true)
				} else {
					writeBoundaryError(w, 401, "caller_context_invalid", "Caller context verification failed", false)
				}
				return
			}
			if !organizationID.MatchString(claims.Organization) || !userID.MatchString(claims.Subject) {
				writeBoundaryError(w, 401, "caller_context_invalid", "Caller identity is invalid", false)
				return
			}
			if claims.SystemRole != "admin" && claims.OrganizationRole != "admin" {
				writeBoundaryError(w, 403, "forbidden", "Administrator access is required", false)
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), claimsKey{}, claims))
		}
		if jsonBody && !validJSONMedia(r.Header) {
			writeBoundaryError(w, 415, "unsupported_media_type", "UTF-8 application/json is required", false)
			return
		}
		if !jsonBody && r.Method == http.MethodPost && !validMultipartMedia(r.Header) {
			writeBoundaryError(w, 415, "unsupported_media_type", "One unencoded multipart/form-data upload is required", false)
			return
		}
		copyRequest := r.Clone(r.Context())
		for name := range copyRequest.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-antnest-") || strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "Cookie") || strings.EqualFold(name, callercontext.Header) || strings.EqualFold(name, serviceauth.Header) {
				delete(copyRequest.Header, name)
			}
		}
		next(w, copyRequest)
	}
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

func validJSONMedia(headers http.Header) bool {
	media, encodings := headerValues(headers, "Content-Type"), headerValues(headers, "Content-Encoding")
	if len(media) != 1 || len(encodings) > 1 || len(encodings) == 1 && encodings[0] != "identity" {
		return false
	}
	kind, params, err := mime.ParseMediaType(media[0])
	return err == nil && kind == "application/json" && len(params) <= 1 && (len(params) == 0 || strings.EqualFold(params["charset"], "utf-8"))
}

func validMultipartMedia(headers http.Header) bool {
	media, encodings := headerValues(headers, "Content-Type"), headerValues(headers, "Content-Encoding")
	if len(media) != 1 || len(encodings) > 1 || len(encodings) == 1 && encodings[0] != "identity" {
		return false
	}
	kind, params, err := mime.ParseMediaType(media[0])
	return err == nil && kind == "multipart/form-data" && len(params) == 1 && params["boundary"] != ""
}

// Console body/query IDs are mandatory echoes; verified claims own the values
// handed to storage. Operation callers keep their accepted operation's scope.
func verifiedScope(r *http.Request, org *string, actor *string) error {
	claims, console := r.Context().Value(claimsKey{}).(callercontext.Claims)
	if !console {
		return nil
	}
	if *org == "" {
		return failure("invalid_request", "Organization identity is required")
	}
	if *org != claims.Organization {
		return failure("organization_mismatch", "Organization differs from verified caller")
	}
	if actor != nil {
		if *actor == "" {
			return failure("invalid_request", "Actor identity is required")
		}
		if *actor != claims.Subject {
			return failure("actor_mismatch", "Actor differs from verified caller")
		}
		*actor = claims.Subject
	}
	*org = claims.Organization
	return nil
}

func writeBoundaryError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "retryable": retryable}})
}

func writeAuthenticationError(w http.ResponseWriter, err error) {
	var rejected *serviceauth.Failure
	if !errors.As(err, &rejected) {
		rejected = serviceauth.Unauthenticated()
	}
	if rejected.Challenge != "" {
		w.Header().Set("WWW-Authenticate", rejected.Challenge)
	}
	writeBoundaryError(w, rejected.Status, rejected.Code, "Service authentication failed", false)
}

func (s Security) validate() error {
	if s.Authentication == nil || s.CallerContext == nil {
		return fmt.Errorf("registry service authentication and caller-context verifier are required")
	}
	return nil
}
