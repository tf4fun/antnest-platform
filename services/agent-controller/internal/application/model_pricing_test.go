package application

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
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
			RequestID: "invalid-price", OrganizationID: "org", ModelProfileID: "profile", DisplayName: "Model",
			Model: model.Parameters(),
		})
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("revise invalid price error=%v", err)
		}
	}
}

func TestAcquireRunPricingCannotMutateStoredSnapshot(t *testing.T) {
	snapshot := validRunSnapshot()
	snapshot.ExecutionSpec.Model.Pricing = usdPricing(2, 8, 0.5)
	cacheWrite := 3.0
	snapshot.ExecutionSpec.Model.Pricing.CacheWritePerMillion = &cacheWrite
	record := ports.RunAdmissionRecord{
		AdmissionID: "admission", AgentID: "agent", PrincipalID: "user", SessionID: "session",
		AccessRevision: "access", RuntimeRevision: "runtime-1", State: domain.AdmissionActive,
		Deadline: time.Unix(2000, 0), Snapshot: snapshot,
	}
	first, err := acquireRunResult(record, true)
	if err != nil {
		t.Fatal(err)
	}
	price := first.ExecutionSpec.Model.Pricing
	*price.InputPerMillion, *price.OutputPerMillion = 99, 99
	*price.CacheReadPerMillion, *price.CacheWritePerMillion = 99, 99
	second, err := acquireRunResult(record, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := second.ExecutionSpec.Model.Pricing; *got.InputPerMillion != 2 || *got.OutputPerMillion != 8 ||
		*got.CacheReadPerMillion != 0.5 || *got.CacheWritePerMillion != 3 {
		t.Fatal("caller mutated replayable pricing")
	}
}
