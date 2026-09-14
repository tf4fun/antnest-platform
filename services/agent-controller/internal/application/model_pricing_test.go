package application

import (
	"context"
	"errors"
	"math"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func usdPricing(input, output, cacheRead float64) *domain.ModelPricing {
	return &domain.ModelPricing{
		Currency: "USD", InputPerMillion: &input, OutputPerMillion: &output, CacheReadPerMillion: &cacheRead,
	}
}

func TestModelProfileFingerprintUsesSubmittedConfiguration(t *testing.T) {
	store := &catalogStoreStub{}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{})
	input := CreateModelProfileInput{
		ProviderConnectionID: "provider-1",
		RequestID:            "pricing-request", OrganizationID: "org-1", ProfileKey: "priced", DisplayName: "Priced",
		Model: validModelInput().Parameters(),
	}
	want, err := requestFingerprint(input)
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.CreateModelProfile(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Model.Pricing != nil || store.modelRecord.RequestFingerprint != want {
		t.Fatal("submitted request identity or unknown pricing changed")
	}
}

func TestModelProfilePricingInvalidInputIsNotAnInternalFailure(t *testing.T) {
	for _, invalid := range []*domain.ModelPricing{
		{}, usdPricing(math.NaN(), 1, 0), usdPricing(1, math.Inf(1), 0), usdPricing(-1, 1, 0),
	} {
		model := validModelInput()
		model.Pricing = invalid
		store := &catalogStoreStub{}
		service := NewCatalogService(store, &sealerStub{}, fixedClock{})
		_, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
			ProviderConnectionID: "provider-1",
			RequestID:            "invalid-price", OrganizationID: "org", ProfileKey: "profile", DisplayName: "Model",
			Model: model.Parameters(),
		})
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("create invalid price error=%v", err)
		}
		_, err = service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
			ExpectedVersion: 1,
			RequestID:       "invalid-price", OrganizationID: "org", ModelProfileID: "profile", DisplayName: "Model",
			Model: model.Parameters(),
		})
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("revise invalid price error=%v", err)
		}
	}
}
