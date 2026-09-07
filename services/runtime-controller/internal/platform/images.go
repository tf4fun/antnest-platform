package platform

import "errors"

var (
	ErrInvalidImageReference      = errors.New("invalid tagged image reference")
	ErrImageNotFound              = errors.New("image is not installed on the deployment platform")
	ErrImageResolutionUnavailable = errors.New("platform image resolution is unavailable")
)

type ImageResolution struct {
	Reference string
	ImageRef  string
}
