package rpc

import (
	"mime"
	"net"
	"net/http"
	"net/netip"
	"strings"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

type Security struct{ Authentication *serviceauth.Receiver }

func localRequest(request *http.Request) bool {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return false
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.IsLoopback()
}

func (h *Handler) authenticate(response http.ResponseWriter, request *http.Request) bool {
	if request.URL.EscapedPath() == "/status" {
		if !localRequest(request) {
			h.notFound(response, request)
			return false
		}
		return true
	}
	_, err := h.security.Authentication.Authorize(request, []string{"agent-controller"})
	if err != nil {
		failure, ok := err.(*serviceauth.Failure)
		if !ok {
			failure = serviceauth.Unauthenticated()
		}
		if failure.Challenge != "" {
			response.Header().Set("WWW-Authenticate", failure.Challenge)
		}
		writeJSON(response, failure.Status, errorResponse{Code: failure.Code, Message: "Verified Controller workload is required", Retryable: false})
		return false
	}
	// RC acts on Controller-owned accepted operations, not browser/user hints.
	for name := range request.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-antnest-") || strings.EqualFold(name, "Antnest-Caller-Context") || strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "Cookie") {
			delete(request.Header, name)
		}
	}
	if request.Method == http.MethodPost || request.Method == http.MethodPut {
		media := request.Header.Values("Content-Type")
		encodings := request.Header.Values("Content-Encoding")
		valid := len(media) == 1 && len(encodings) <= 1
		if valid {
			kind, params, parseErr := mime.ParseMediaType(media[0])
			valid = parseErr == nil && kind == "application/json" && (len(params) == 0 || len(params) == 1 && strings.EqualFold(params["charset"], "utf-8"))
			if len(encodings) == 1 && !strings.EqualFold(encodings[0], "identity") {
				valid = false
			}
		}
		if !valid {
			writeJSON(response, http.StatusUnsupportedMediaType, errorResponse{Code: "unsupported_media_type", Message: "JSON with UTF-8 is required", Retryable: false})
			return false
		}
	}
	return true
}

// HealthHandler is served only by the separate loopback listener. It exposes no
// control routes; the existing readiness projection (including monitor) remains.
func (h *Handler) HealthHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(r) {
			h.notFound(w, r)
			return
		}
		h.status(w, r)
	})
	mux.HandleFunc("/", h.notFound)
	return mux
}
