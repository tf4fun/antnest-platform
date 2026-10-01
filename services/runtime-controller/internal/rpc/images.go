package rpc

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

type imageResolutionResponse struct {
	Reference string `json:"reference"`
	ImageRef  string `json:"image_ref"`
}

func (h *Handler) resolveImage(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(query) != 1 || len(query["reference"]) != 1 {
		writeError(response, platform.ErrInvalidImageReference)
		return
	}
	reference := strings.TrimSpace(query.Get("reference"))
	if reference == "" || len(reference) > 512 {
		writeError(response, platform.ErrInvalidImageReference)
		return
	}
	image, err := h.service.ResolveImage(request.Context(), reference)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, imageResolutionResponse{Reference: image.Reference, ImageRef: image.ImageRef})
}

func classifyImageError(err error) (errorDescriptor, bool) {
	switch {
	case errors.Is(err, platform.ErrInvalidImageReference):
		return errorDescriptor{status: http.StatusBadRequest, response: errorResponse{
			Code: "invalid_request", Message: "Select a valid image name, tag or digest reference", Retryable: false,
		}}, true
	case errors.Is(err, platform.ErrImageNotFound):
		return errorDescriptor{status: http.StatusNotFound, response: errorResponse{
			Code: "image_not_found", Message: "Runtime image is not installed; ask the platform operator to build or load it first", Retryable: false,
		}}, true
	case errors.Is(err, context.DeadlineExceeded):
		return errorDescriptor{}, false
	case errors.Is(err, platform.ErrImageResolutionUnavailable):
		return errorDescriptor{status: http.StatusServiceUnavailable, response: errorResponse{
			Code: "platform_unavailable", Message: "Runtime image resolution is temporarily unavailable", Retryable: true,
		}}, true
	default:
		return errorDescriptor{}, false
	}
}
