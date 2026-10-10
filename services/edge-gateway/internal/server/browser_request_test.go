package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
)

// newBrowserRequest supplies the Origin a browser sends on API mutations.
// Tests of absent or malformed admission evidence use httptest.NewRequest
// directly; deployments whose public and transport origins differ set Origin
// explicitly after constructing their request.
func newBrowserRequest(method, target string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	if strings.HasPrefix(request.URL.Path, "/api/") &&
		method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions {
		scheme := "http"
		if request.TLS != nil {
			scheme = "https"
		}
		request.Header.Set("Origin", scheme+"://"+request.Host)
	}
	return request
}
