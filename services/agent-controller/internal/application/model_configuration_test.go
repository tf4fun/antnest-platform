package application

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
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

func TestModelConfigurationPreservesTokenizerAndCompactionProfileID(t *testing.T) {
	for _, tokenizer := range []string{"o200k", "cl100k", "none"} {
		t.Run(tokenizer, func(t *testing.T) {
			store := &catalogStoreStub{}
			service := NewCatalogService(store, &sealerStub{}, fixedClock{})
			var parameters domain.ModelParameters
			err := json.Unmarshal([]byte(`{"model":"deepseek-v4-flash","context_window":4096,
"max_output_tokens":512,"tokenizer":"`+tokenizer+`","compaction_model_profile_id":"compactor-v2"}`), &parameters)
			if err != nil {
				t.Fatal(err)
			}
			created, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
				ProviderConnectionID: "provider-1",
				RequestID:            "create", OrganizationID: "org", ProfileKey: "model", DisplayName: "Model",
				Model: parameters,
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, model := range []domain.ModelSpec{created.Model, store.modelRecord.Revision.Snapshot().Model} {
				if got := modelStringField(t, model, "Tokenizer"); got != tokenizer {
					t.Fatalf("created Tokenizer = %q, want %q", got, tokenizer)
				}
				if got := modelStringField(t, model, "CompactionModelProfileID"); got != "compactor-v2" {
					t.Fatalf("created CompactionModelProfileID = %q, want %q", got, "compactor-v2")
				}
			}
			var revision domain.ModelParameters
			err = json.Unmarshal([]byte(`{"model":"deepseek-v4-flash","context_window":8192,
"max_output_tokens":512,"tokenizer":"cl100k","compaction_model_profile_id":"compactor-v3"}`), &revision)
			if err != nil {
				t.Fatal(err)
			}
			revised, err := service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
				ExpectedVersion: created.Revision,
				RequestID:       "revise", OrganizationID: "org", ModelProfileID: created.ModelProfileID, DisplayName: "Model",
				Model: revision,
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, model := range []domain.ModelSpec{revised.Model, store.modelRecord.Revision.Snapshot().Model} {
				if got := modelStringField(t, model, "Tokenizer"); got != "cl100k" {
					t.Fatalf("revised Tokenizer = %q, want %q", got, "cl100k")
				}
				if got := modelStringField(t, model, "CompactionModelProfileID"); got != "compactor-v3" {
					t.Fatalf("revised CompactionModelProfileID = %q, want %q", got, "compactor-v3")
				}
			}
		})
	}
}

func modelStringField(t *testing.T, model domain.ModelSpec, name string) string {
	t.Helper()
	field := reflect.ValueOf(model).FieldByName(name)
	if !field.IsValid() || field.Kind() != reflect.String {
		t.Fatalf("model is missing string field %s", name)
	}
	return field.String()
}
