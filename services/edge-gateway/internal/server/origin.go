package server

import "net/http"

// admitOrigin is independent of authentication and CSRF. A compatibility client
// may omit both headers, but it cannot override contradictory browser evidence.
func (h *handler) admitOrigin(request *http.Request) bool {
	originPresent := len(request.Header.Values("Origin")) != 0
	if !stateChanging(request.Method) {
		return !originPresent || h.sameOrigin(request)
	}
	metadata := request.Header.Values("Sec-Fetch-Site")
	if len(metadata) > 1 {
		return false
	}
	if len(metadata) == 1 {
		switch metadata[0] {
		case "same-origin", "none":
		default:
			// Cross-site, same-site and malformed values are never overridden by
			// a matching Origin or the originless compatibility setting.
			return false
		}
	}
	if originPresent {
		return h.sameOrigin(request)
	}
	if len(metadata) == 1 {
		return metadata[0] == "same-origin"
	}
	return h.allowOriginlessMutations
}
