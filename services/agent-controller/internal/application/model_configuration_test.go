package application

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestModelConfigurationPreservesSubmittedMetadata(t *testing.T) {
	for _, modelID := range []string{"deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "company-model"} {
		for _, pricing := range []*domain.ModelPricing{nil, usdPricing(0, 0, 0), usdPricing(5, 9, 1)} {
			t.Run(modelID, func(t *testing.T) {
				store := &catalogStoreStub{}
				service := NewCatalogService(store, &sealerStub{}, fixedClock{})
				model := domain.ModelSpec{
					BaseURL: validModelInput().BaseURL, Model: modelID,
					ContextWindow: 4096, MaxOutputTokens: 512, Pricing: pricing,
				}
				created, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
					ProviderConnectionID: "provider-1",
					RequestID:            "create", OrganizationID: "org", ProfileKey: "model", DisplayName: "Model",
					Model: model.Parameters(),
				})
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(created.Model, model) || !reflect.DeepEqual(store.modelRecord.Revision.Snapshot().Model, model) {
					t.Fatalf("creation replaced submitted configuration: got=%+v want=%+v", created.Model, model)
				}
				model.ContextWindow = 8192
				model.SupportsImages = true
				revised, err := service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
					ExpectedVersion: created.Revision,
					RequestID:       "revise", OrganizationID: "org", ModelProfileID: created.ModelProfileID, DisplayName: "Model",
					Model: model.Parameters(),
				})
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(revised.Model, model) || !reflect.DeepEqual(store.modelRecord.Revision.Snapshot().Model, model) {
					t.Fatalf("revision replaced submitted configuration: got=%+v want=%+v", revised.Model, model)
				}
			})
		}
	}
}

func TestKnownModelNameDoesNotBypassConfigurationValidation(t *testing.T) {
	store := &catalogStoreStub{}
	sealer := &sealerStub{}
	service := NewCatalogService(store, sealer, fixedClock{})
	_, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
		ProviderConnectionID: "provider-1",
		RequestID:            "invalid", OrganizationID: "org", ProfileKey: "model", DisplayName: "Model",
		Model: domain.ModelParameters{Model: "deepseek-v4-flash"},
	})
	if !errors.Is(err, ErrInvalidInput) || sealer.calls != 0 {
		t.Fatalf("incomplete configuration was accepted: err=%v seals=%d", err, sealer.calls)
	}
}
