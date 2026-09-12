package application

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestModelEditRejectsStaleFormWithoutOverwritingCurrentModel(t *testing.T) {
	store := &catalogStoreStub{}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{})
	created, err := service.CreateModelProfile(context.Background(), editableModelInput("Original"))
	if err != nil {
		t.Fatal(err)
	}
	edit := ReviseModelProfileInput{
		RequestID: "edit-one", OrganizationID: "org", ModelProfileID: created.ModelProfileID,
		ExpectedVersion: created.Revision, DisplayName: "First admin", Model: created.Model.Parameters(),
	}
	edit.Model.ContextWindow = 16384
	first, err := service.ReviseModelProfile(context.Background(), edit)
	if err != nil {
		t.Fatal(err)
	}
	edit.RequestID, edit.DisplayName = "edit-two", "Stale admin"
	edit.Model = created.Model.Parameters()
	if _, err := service.ReviseModelProfile(context.Background(), edit); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale form accepted: %v", err)
	}
	if store.expectedModelRevision != created.Revision || !reflect.DeepEqual(modelProfileView(store.modelRecord), first) {
		t.Fatal("stale form changed current model or ignored the caller version")
	}
	edit.ExpectedVersion = first.Revision
	updated, err := service.ReviseModelProfile(context.Background(), edit)
	if err != nil || updated.Revision != first.Revision+1 {
		t.Fatalf("fresh form did not save: revision=%d error=%v", updated.Revision, err)
	}
}

func TestModelEditRequiresPositiveExpectedVersion(t *testing.T) {
	for _, version := range []int64{0, -1} {
		store := &catalogStoreStub{}
		service := NewCatalogService(store, &sealerStub{}, fixedClock{})
		created, err := service.CreateModelProfile(context.Background(), editableModelInput("Original"))
		if err != nil {
			t.Fatal(err)
		}
		_, err = service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
			RequestID: "edit", OrganizationID: "org", ModelProfileID: created.ModelProfileID,
			ExpectedVersion: version, DisplayName: "Changed", Model: created.Model.Parameters(),
		})
		if !errors.Is(err, ErrInvalidInput) || store.expectedModelRevision != 0 {
			t.Fatalf("invalid version %d reached persistence: %v", version, err)
		}
	}
}

func TestModelDisplayNameLimitsApplyToEveryWritePath(t *testing.T) {
	cases := []struct {
		name  string
		valid bool
	}{
		{strings.Repeat("a", 200), true},
		{strings.Repeat("\u6a21", 200), true},
		{strings.Repeat("\U0001f680", 200), true},
		{strings.Repeat("a", 201), false},
		{strings.Repeat("\u6a21", 201), false},
		{" \t\u3000", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			assertModelDisplayNameWrites(t, test.name, test.valid)
		})
	}
}

func assertModelDisplayNameWrites(t *testing.T, name string, valid bool) {
	t.Helper()
	store := &catalogStoreStub{}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{})
	_, err := service.CreateModelProfile(context.Background(), editableModelInput(name))
	assertModelNameResult(t, "create", valid, err)
	created, err := service.CreateModelProfile(context.Background(), editableModelInput("Original"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
		RequestID: "edit", OrganizationID: "org", ModelProfileID: created.ModelProfileID,
		ExpectedVersion: created.Revision, DisplayName: name, Model: created.Model.Parameters(),
	})
	assertModelNameResult(t, "edit", valid, err)
	providerStore := &providerStoreStub{}
	sealer := &sealerStub{}
	input := providerCreateInput()
	input.Models[0].DisplayName = name
	_, err = NewCatalogService(providerStore, sealer, fixedClock{}).CreateProviderConnection(context.Background(), input)
	assertModelNameResult(t, "initial model", valid, err)
	if !valid && (providerStore.writes != 0 || sealer.calls != 0) {
		t.Fatal("invalid initial model caused side effects")
	}
}

func assertModelNameResult(t *testing.T, operation string, valid bool, err error) {
	t.Helper()
	if valid && err != nil {
		t.Fatalf("%s rejected valid name: %v", operation, err)
	}
	if !valid && !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("%s accepted invalid name: %v", operation, err)
	}
}

func editableModelInput(name string) CreateModelProfileInput {
	return CreateModelProfileInput{
		RequestID: "create", OrganizationID: "org", ProviderConnectionID: "provider-1",
		ProfileKey: "model", DisplayName: name, Model: validModelInput().Parameters(),
	}
}
