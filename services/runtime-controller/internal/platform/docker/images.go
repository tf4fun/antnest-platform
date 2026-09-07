package docker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/distribution/reference"
	"github.com/opencontainers/go-digest"

	"soft/antnest-platform/services/runtime-controller/internal/platform"
)

func (c *Client) InspectImage(ctx context.Context, image string) (string, error) {
	var response struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodGet, "/images/"+url.PathEscape(image)+"/json", nil, &response); err != nil {
		return "", err
	}
	return response.ID, nil
}

func (d *Driver) ResolveImage(ctx context.Context, value string) (platform.ImageResolution, error) {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > 512 {
		return platform.ImageResolution{}, platform.ErrInvalidImageReference
	}
	parsed, err := reference.ParseAnyReference(value)
	named, tagged := parsed.(reference.NamedTagged)
	_, pinned := parsed.(reference.Digested)
	if err != nil || !tagged || pinned {
		return platform.ImageResolution{}, platform.ErrInvalidImageReference
	}
	name := reference.FamiliarString(named)
	imageID, err := d.engine.InspectImage(ctx, name)
	if errors.Is(err, ErrNotFound) {
		return platform.ImageResolution{}, platform.ErrImageNotFound
	}
	if err != nil {
		return platform.ImageResolution{}, fmt.Errorf("%w: %w", platform.ErrImageResolutionUnavailable, err)
	}
	identity, err := digest.Parse(imageID)
	if err != nil || identity.Algorithm() != digest.SHA256 {
		return platform.ImageResolution{}, platform.ErrImageResolutionUnavailable
	}
	return platform.ImageResolution{Reference: name, ImageRef: imageID}, nil
}
