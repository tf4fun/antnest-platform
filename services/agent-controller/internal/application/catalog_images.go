package application

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var ErrRuntimeImageSelection = errors.New("select an installed Runtime image")

func (service *CatalogService) resolveTemplateImage(
	ctx context.Context, input, current domain.RuntimeSpecInput,
) (domain.RuntimeSpecInput, error) {
	if input.ImageSource != "" {
		return domain.RuntimeSpecInput{}, fmt.Errorf("%w: image source is server-derived", ErrInvalidInput)
	}
	input.ImageRef = strings.TrimSpace(input.ImageRef)
	if domain.IsImmutableImageReference(input.ImageRef) {
		if input.ImageRef == current.ImageRef {
			input.ImageSource = current.ImageSource
		}
		return input, nil
	}
	if input.ImageRef == "" || len(input.ImageRef) > 512 {
		return domain.RuntimeSpecInput{}, errors.Join(ErrInvalidInput, ErrRuntimeImageSelection)
	}
	if service.images == nil {
		return domain.RuntimeSpecInput{}, fmt.Errorf("%w: image resolver", ErrDependencyUnavailable)
	}
	image, err := service.images.ResolveImage(ctx, input.ImageRef)
	if err != nil {
		return domain.RuntimeSpecInput{}, imageSelectionFailure(err)
	}
	if !domain.IsImmutableImageReference(image.ImageRef) || strings.TrimSpace(image.Reference) == "" || len(image.Reference) > 512 {
		return domain.RuntimeSpecInput{}, fmt.Errorf("%w: invalid image resolution", ErrDependencyUnavailable)
	}
	input.ImageRef, input.ImageSource = image.ImageRef, image.Reference
	return input, nil
}

func imageSelectionFailure(err error) error {
	var failure *ports.DependencyError
	if errors.As(err, &failure) && (failure.Code == "invalid_request" || failure.Code == "image_not_found") {
		return errors.Join(ErrInvalidInput, ErrRuntimeImageSelection)
	}
	return fmt.Errorf("%w: image resolution: %w", ErrDependencyUnavailable, err)
}
