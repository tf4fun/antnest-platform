package control

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

func TestResolveImageDoesNotUseLifecycleState(t *testing.T) {
	want := platform.ImageResolution{Reference: "antnest/runtime:local", ImageRef: "immutable-image"}
	for _, cause := range []error{nil, platform.ErrImageNotFound} {
		ctx, cancel := context.WithCancel(context.Background())
		calls := 0
		service := &Service{platform: imagePlatform{resolve: func(got context.Context, reference string) (platform.ImageResolution, error) {
			calls++
			if got != ctx || reference != want.Reference {
				t.Fatalf("query context or reference changed: %q", reference)
			}
			return want, cause
		}}}
		result, err := service.ResolveImage(ctx, want.Reference)
		cancel()
		if calls != 1 || result != want || !errors.Is(err, cause) {
			t.Fatalf("result = %+v, error = %v, calls = %d", result, err, calls)
		}
	}
}

type imagePlatform struct {
	platform.Lifecycle
	resolve func(context.Context, string) (platform.ImageResolution, error)
}

func (p imagePlatform) ResolveImage(ctx context.Context, reference string) (platform.ImageResolution, error) {
	return p.resolve(ctx, reference)
}
