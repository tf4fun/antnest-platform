package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestTemplateImageChoiceIsResolvedAndFrozenBeforePublication(t *testing.T) {
	service, store, images := imageCatalog(t)
	input := taggedTemplateInput()
	view, err := service.CreateTemplate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if images.calls != 1 || images.reference != input.Runtime.ImageRef ||
		view.Runtime.ImageRef != images.result.ImageRef || view.Runtime.ImageSource != images.result.Reference {
		t.Fatalf("runtime = %+v, resolver = %+v", view.Runtime, images)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil || fingerprint != store.templateRecord.RequestFingerprint {
		t.Fatal("request fingerprint must retain the original choice, not its current image ID")
	}
	if _, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileRevisionID: input.ModelProfileRevisionID, Runtime: input.Runtime,
		MaxModelRequests: 32, ContextPolicyVersion: domain.ContextPolicyV1,
	}); err == nil {
		t.Fatal("published domain accepted an unresolved image tag")
	}
}

func TestTemplateImageReplayDoesNotResolveMovedTag(t *testing.T) {
	service, store, images := imageCatalog(t)
	input := taggedTemplateInput()
	first, err := service.CreateTemplate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	store.templateReplay, store.replayFound = store.templateRecord, true
	images.result.ImageRef = "sha256:" + strings.Repeat("b", 64)
	images.err = errors.New("resolver unavailable")
	replayed, err := service.CreateTemplate(context.Background(), input)
	if err != nil || replayed.Runtime != first.Runtime || images.calls != 1 {
		t.Fatalf("replay = %+v, err = %v, calls = %d", replayed.Runtime, err, images.calls)
	}
}

func TestTemplateImageRevisionPreservesPinUnlessTagExplicitlySelected(t *testing.T) {
	service, store, images := imageCatalog(t)
	created, err := service.CreateTemplate(context.Background(), taggedTemplateInput())
	if err != nil {
		t.Fatal(err)
	}
	input := ReviseTemplateInput{
		RequestID: "revise-1", OrganizationID: "org-1", TemplateID: created.TemplateID,
		Name: "Changed prompt", SystemPrompt: "New prompt", ModelProfileRevisionID: created.ModelProfileRevisionID,
		MaxModelRequests: 32, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: created.Runtime,
	}
	input.Runtime.ImageSource = ""
	images.err = errors.New("resolver offline")
	preserved, err := service.ReviseTemplate(context.Background(), input)
	if err != nil || preserved.Runtime != created.Runtime || images.calls != 1 {
		t.Fatalf("preserved = %+v, error = %v, calls = %d", preserved.Runtime, err, images.calls)
	}
	images.err = nil
	images.result.ImageRef = "sha256:" + strings.Repeat("b", 64)
	input.RequestID, input.Runtime.ImageRef = "revise-2", images.result.Reference
	refreshed, err := service.ReviseTemplate(context.Background(), input)
	if err != nil || refreshed.Runtime.ImageRef != images.result.ImageRef || images.calls != 2 {
		t.Fatalf("explicit selection = %+v, error = %v", refreshed.Runtime, err)
	}
	store.templateReplay, store.replayFound = store.templateRecord, true
	images.err = errors.New("resolver offline again")
	replayed, err := service.ReviseTemplate(context.Background(), input)
	if err != nil || replayed.Runtime != refreshed.Runtime || images.calls != 2 {
		t.Fatalf("revision replay changed its pin: %+v, %v", replayed, err)
	}
}

func TestTemplateImageResolutionOccursAfterReferenceScopeChecks(t *testing.T) {
	service, store, images := imageCatalog(t)
	input := taggedTemplateInput()
	input.OrganizationID = "org-other"
	if _, err := service.CreateTemplate(context.Background(), input); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("scope error = %v", err)
	}
	if images.calls != 0 || store.templateRecord.TemplateID != "" {
		t.Fatal("invalid reference reached image resolution or publication")
	}
}

func TestTemplateImageFailureDoesNotPublish(t *testing.T) {
	for _, test := range []struct {
		name    string
		code    string
		invalid bool
	}{
		{"missing", "image_not_found", true},
		{"untagged", "invalid_request", true},
		{"unavailable", "platform_unavailable", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			service, store, images := imageCatalog(t)
			images.err = &ports.DependencyError{Service: "runtime-controller", Code: test.code, Retryable: !test.invalid}
			_, err := service.CreateTemplate(context.Background(), taggedTemplateInput())
			if err == nil || errors.Is(err, ErrInvalidInput) != test.invalid || store.templateRecord.TemplateID != "" {
				t.Fatalf("error = %v, stored = %+v", err, store.templateRecord)
			}
		})
	}
}

func TestTemplateRejectsCallerSuppliedImageSource(t *testing.T) {
	service, store, images := imageCatalog(t)
	input := taggedTemplateInput()
	input.Runtime.ImageRef = images.result.ImageRef
	input.Runtime.ImageSource = "trusted/runtime:forged"
	if _, err := service.CreateTemplate(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("forged source accepted: %v", err)
	}
	if store.templateRecord.TemplateID != "" || images.calls != 0 {
		t.Fatal("forged source caused resolution or publication")
	}
}

func TestTemplateRejectsUnresolvedPlatformResult(t *testing.T) {
	service, store, images := imageCatalog(t)
	images.result.ImageRef = "antnest/runtime:mutable"
	if _, err := service.CreateTemplate(context.Background(), taggedTemplateInput()); !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("invalid image resolution accepted: %v", err)
	}
	if store.templateRecord.TemplateID != "" {
		t.Fatal("invalid image resolution was persisted")
	}
}

func imageCatalog(t *testing.T) (*CatalogService, *catalogStoreStub, *imageResolverStub) {
	t.Helper()
	store := &catalogStoreStub{modelRevision: mustModelRevision(t, "model-revision-1", "org-1")}
	images := &imageResolverStub{result: ports.ResolvedImage{
		Reference: "antnest/runtime:local", ImageRef: "sha256:" + strings.Repeat("a", 64),
	}}
	return NewCatalogService(store, &sealerStub{}, images, fixedClock{now: time.Unix(1, 0).UTC()}), store, images
}

func taggedTemplateInput() CreateTemplateInput {
	runtime := validRuntimeInput()
	runtime.ImageRef = "antnest/runtime:local"
	return CreateTemplateInput{
		RequestID: "create-image", OrganizationID: "org-1", TemplateKey: "personal", Name: "Personal Agent",
		ModelProfileRevisionID: "model-revision-1", MaxModelRequests: 32,
		ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtime,
	}
}

type imageResolverStub struct {
	calls     int
	reference string
	result    ports.ResolvedImage
	err       error
}

func (resolver *imageResolverStub) ResolveImage(_ context.Context, reference string) (ports.ResolvedImage, error) {
	resolver.calls++
	resolver.reference = reference
	return resolver.result, resolver.err
}
