package rpc

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"soft/antnest-platform/services/runtime-controller/internal/platform"
)

type imageResolutionResponse struct {
	Reference string `json:"reference"`
	ImageRef  string `json:"image_ref"`
}

func (h *Handler) resolveImage(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(query) != 1 || len(query["reference"]) != 1 {
		writeImageError(response, platform.ErrInvalidImageReference)
		return
	}
	reference := strings.TrimSpace(query.Get("reference"))
	if reference == "" || len(reference) > 512 {
		writeImageError(response, platform.ErrInvalidImageReference)
		return
	}
	image, err := h.service.ResolveImage(request.Context(), reference)
	if err != nil {
		writeImageError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, imageResolutionResponse{Reference: image.Reference, ImageRef: image.ImageRef})
}

func writeImageError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, platform.ErrInvalidImageReference):
		writeJSON(response, http.StatusBadRequest, errorResponse{
			Code: "invalid_request", Message: "Select an explicit repository:tag image reference", Retryable: false,
		})
	case errors.Is(err, platform.ErrImageNotFound):
		writeJSON(response, http.StatusNotFound, errorResponse{
			Code: "image_not_found", Message: "Runtime image is not installed; ask the platform operator to build or load it first", Retryable: false,
		})
	case errors.Is(err, context.DeadlineExceeded):
		writeError(response, err)
	case errors.Is(err, platform.ErrImageResolutionUnavailable):
		writeJSON(response, http.StatusServiceUnavailable, errorResponse{
			Code: "platform_unavailable", Message: "Runtime image resolution is temporarily unavailable", Retryable: true,
		})
	default:
		writeError(response, err)
	}
}
