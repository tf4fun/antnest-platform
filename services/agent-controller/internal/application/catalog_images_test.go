package application

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTemplatePreservesSubmittedImageWithoutRuntimeDependency(t *testing.T) {
	for _, image := range []string{
		"antnest/runtime:latest", "antnest/runtime:v2", "registry.example:5000/runtime:missing",
		"runtime", "sha256:" + strings.Repeat("a", 64),
		"registry.example/runtime@sha256:" + strings.Repeat("b", 64),
	} {
		t.Run(image, func(t *testing.T) {
			store := &catalogStoreStub{modelRevision: mustModelRevision(t, "model-revision-1", "org-1")}
			service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()})
			input := taggedTemplateInput()
			input.Runtime.ImageRef = image
			created, err := service.CreateTemplate(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(created.Runtime, input.Runtime) ||
				!reflect.DeepEqual(store.templateRecord.Revision.Snapshot().Runtime, input.Runtime) {
				t.Fatal("template changed the submitted Runtime configuration")
			}
			store.templateReplay, store.replayFound = store.templateRecord, true
			replayed, err := service.CreateTemplate(context.Background(), input)
			if err != nil || !reflect.DeepEqual(replayed, created) {
				t.Fatalf("replay = %+v, error = %v", replayed, err)
			}
			store.replayFound = false
			revision := ReviseTemplateInput{
				RequestID: "revise-1", OrganizationID: input.OrganizationID, TemplateID: created.TemplateID,
				Name: created.Name, SystemPrompt: "Updated prompt", ModelProfileID: created.ModelProfileID,
				MaxModelRequests: 32, ContextPolicyVersion: input.ContextPolicyVersion, Runtime: input.Runtime,
			}
			revised, err := service.ReviseTemplate(context.Background(), revision)
			if err != nil || revised.Revision != 2 || !reflect.DeepEqual(revised.Runtime, input.Runtime) {
				t.Fatalf("revision = %+v, error = %v", revised, err)
			}
		})
	}
}

func TestTemplateRejectsMalformedImageWithoutPublishing(t *testing.T) {
	for _, image := range []string{"", "runtime:bad tag", "https://registry/runtime:latest", " runtime:latest", "runtime@sha256:bad", strings.Repeat("a", 513)} {
		t.Run(image, func(t *testing.T) {
			store := &catalogStoreStub{modelRevision: mustModelRevision(t, "model-revision-1", "org-1")}
			service := NewCatalogService(store, &sealerStub{}, fixedClock{})
			input := taggedTemplateInput()
			input.Runtime.ImageRef = image
			if _, err := service.CreateTemplate(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("invalid reference accepted: %v", err)
			}
			if store.templateRecord.TemplateID != "" {
				t.Fatal("invalid image was published")
			}
		})
	}
}

func taggedTemplateInput() CreateTemplateInput {
	runtime := validRuntimeInput()
	runtime.ImageRef = "antnest/runtime:latest"
	return CreateTemplateInput{
		RequestID: "create-image", OrganizationID: "org-1", TemplateKey: "personal", Name: "Personal Agent",
		ModelProfileID: "model-1", MaxModelRequests: 32,
		ContextPolicyVersion: "context-v1", Runtime: runtime,
	}
}
