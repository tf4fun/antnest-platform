package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestCreateModelProfileSealsCredentialAndPersistsImmutableRevision(t *testing.T) {
	t.Parallel()

	store := &catalogStoreStub{}
	sealer := &sealerStub{sealed: ports.SealedSecret{Ciphertext: []byte("ciphertext"), Nonce: []byte("nonce")}}
	service := NewCatalogService(store, sealer, fixedClock{now: time.Unix(1, 0).UTC()})

	created, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
		RequestID: "request-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Model: validModelInput(), CredentialSecret: "secret-value",
	})
	if err != nil {
		t.Fatalf("create model profile: %v", err)
	}
	if created.ModelProfileID == "" || created.RevisionID == "" || created.CredentialRef == "" {
		t.Fatalf("generated identities are incomplete: %+v", created)
	}
	if store.modelRecord.Revision.ID() != created.RevisionID {
		t.Fatal("persisted revision differs from response")
	}
	if string(store.modelRecord.SealedCredential.Ciphertext) != "ciphertext" {
		t.Fatal("sealed credential was not persisted")
	}
	if sealer.plaintext != "secret-value" {
		t.Fatal("credential was not passed to sealer")
	}
	if sealer.identity.CredentialRef != created.CredentialRef || sealer.identity.OrganizationID != "org-1" {
		t.Fatal("credential identity was not bound as authenticated encryption context")
	}
	if store.modelRecord.RequestFingerprint == "" || store.modelRecord.RequestFingerprint == "secret-value" {
		t.Fatal("request fingerprint is missing or leaks the secret")
	}
}

func TestCreateModelProfileCanonicalizesKnownModelMetadata(t *testing.T) {
	t.Parallel()

	store := &catalogStoreStub{}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()})
	created, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
		RequestID: "request-known-model", OrganizationID: "org-1", ProfileKey: "deepseek-v4-pro",
		DisplayName: "DeepSeek V4 Pro", CredentialSecret: "secret-value",
		Model: domain.ModelSpec{
			BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-v4-pro",
			ContextWindow: 2048, MaxOutputTokens: 32, SupportsImages: true,
		},
	})
	if err != nil {
		t.Fatalf("create known model profile: %v", err)
	}
	if created.Model.BaseURL != "https://api.deepseek.com" || created.Model.ContextWindow != 1_000_000 ||
		created.Model.MaxOutputTokens != 384_000 || created.Model.SupportsImages {
		t.Fatalf("created model metadata = %+v", created.Model)
	}
}

func TestCreateModelProfileRetryUsesDeterministicResourceIdentities(t *testing.T) {
	t.Parallel()

	store := &catalogStoreStub{}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()})
	input := CreateModelProfileInput{
		RequestID: "request-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Model: validModelInput(), CredentialSecret: "secret-value",
	}
	first, err := service.CreateModelProfile(context.Background(), input)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	firstRecord := store.modelRecord
	second, err := service.CreateModelProfile(context.Background(), input)
	if err != nil {
		t.Fatalf("retry create: %v", err)
	}
	if first.ModelProfileID != second.ModelProfileID || first.RevisionID != second.RevisionID {
		t.Fatalf("retry identities changed: %+v %+v", first, second)
	}
	if firstRecord.RequestFingerprint != store.modelRecord.RequestFingerprint {
		t.Fatal("retry fingerprint changed")
	}
}

func TestCreateModelProfileReplaysCompletedRequestBeforeSealing(t *testing.T) {
	t.Parallel()

	replayed := ports.ModelProfileRecord{
		ModelProfileID: "model-existing", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Revision: mustModelRevision(t, "model-revision-existing", "org-1"),
		CredentialRef: "credential-existing", CredentialVersion: "credential-version-existing",
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	store := &catalogStoreStub{modelReplay: replayed, replayFound: true}
	sealer := &sealerStub{err: errors.New("sealer unavailable")}
	service := NewCatalogService(store, sealer, fixedClock{now: time.Unix(2, 0).UTC()})

	view, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
		RequestID: "request-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Model: validModelInput(), CredentialSecret: "secret-value",
	})
	if err != nil {
		t.Fatalf("replay completed ModelProfile request: %v", err)
	}
	if view.ModelProfileID != replayed.ModelProfileID || sealer.calls != 0 {
		t.Fatalf("completed request was not replayed before sealing: view=%+v calls=%d", view, sealer.calls)
	}
}

func TestCreateTemplateMaterializesOnlyMatchingOrganizationModel(t *testing.T) {
	t.Parallel()

	model, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-1",
		Revision: 1, Model: validModelInput(), CredentialRef: "credential-1",
		CredentialVersion: "credential-version-1",
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	store := &catalogStoreStub{modelRevision: model}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()})

	created, err := service.CreateTemplate(context.Background(), CreateTemplateInput{
		RequestID: "request-2", OrganizationID: "org-1", TemplateKey: "personal",
		Name: "Personal Agent", ModelProfileRevisionID: "model-revision-1",
		SystemPrompt: "You are helpful.", MaxModelRequests: 16,
		ContextPolicyVersion: "context-v1", Runtime: validRuntimeInput(),
	})
	if err != nil {
		t.Fatalf("create template: %v", err)
	}
	if created.TemplateID == "" || created.Revision != 1 {
		t.Fatalf("unexpected Template response: %+v", created)
	}
	if store.templateRecord.Revision.ModelProfileRevisionID() != model.ID() {
		t.Fatal("Template did not retain the resolved model revision")
	}

	store.modelRevision = mustModelRevision(t, "model-revision-2", "org-2")
	_, err = service.CreateTemplate(context.Background(), CreateTemplateInput{
		RequestID: "request-3", OrganizationID: "org-1", TemplateKey: "invalid",
		Name: "Invalid", ModelProfileRevisionID: "model-revision-2",
		SystemPrompt: "prompt", MaxModelRequests: 8,
		ContextPolicyVersion: "context-v1", Runtime: validRuntimeInput(),
	})
	if !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization model error = %v", err)
	}
}

func TestReviseModelProfileBuildsNextRevisionAgainstLockedHead(t *testing.T) {
	t.Parallel()

	current := ports.ModelProfileRecord{
		ModelProfileID: "model-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Revision: mustModelRevision(t, "model-revision-1", "org-1"),
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	store := &catalogStoreStub{modelRecord: current}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(2, 0).UTC()})
	if _, err := service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
		RequestID: "request-denied", OrganizationID: "org-2",
		ModelProfileID: "model-1", DisplayName: "Denied",
		Model: validModelInput(), CredentialSecret: "new-secret",
	}); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization ModelProfile revision error = %v", err)
	}

	view, err := service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
		RequestID: "request-revise", OrganizationID: "org-1",
		ModelProfileID: "model-1", DisplayName: "DeepSeek V2",
		Model: validModelInput(), CredentialSecret: "new-secret",
	})
	if err != nil {
		t.Fatalf("revise ModelProfile: %v", err)
	}
	if store.expectedModelRevision != 1 || store.modelRecord.Revision.Revision() != 2 {
		t.Fatalf("revision CAS was not preserved: expected=%d record=%+v", store.expectedModelRevision, store.modelRecord)
	}
	if view.ModelProfileID != "model-1" || view.Revision != 2 || view.DisplayName != "DeepSeek V2" {
		t.Fatalf("unexpected revised profile: %+v", view)
	}
}

func TestReviseTemplateRejectsCrossOrganizationModelAndBuildsNextRevision(t *testing.T) {
	t.Parallel()

	currentRevision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileRevisionID: "model-revision-1", SystemPrompt: "old",
		MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: validRuntimeInput(),
	})
	if err != nil {
		t.Fatalf("create current Template revision: %v", err)
	}
	store := &catalogStoreStub{
		templateRecord: ports.TemplateRecord{
			TemplateID: "template-1", OrganizationID: "org-1", TemplateKey: "personal",
			Name: "Personal", Revision: currentRevision, Enabled: true,
			CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
		},
		modelRevision: mustModelRevision(t, "model-revision-2", "org-2"),
	}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(2, 0).UTC()})
	input := ReviseTemplateInput{
		RequestID: "request-template-revise", OrganizationID: "org-1",
		TemplateID: "template-1", Name: "Personal V2",
		ModelProfileRevisionID: "model-revision-2", SystemPrompt: "new", MaxModelRequests: 16,
		ContextPolicyVersion: domain.ContextPolicyV1, Runtime: validRuntimeInput(),
	}
	denied := input
	denied.RequestID = "request-template-denied"
	denied.OrganizationID = "org-2"
	if _, err := service.ReviseTemplate(context.Background(), denied); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization Template revision error = %v", err)
	}
	if _, err := service.ReviseTemplate(context.Background(), input); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization revision error = %v", err)
	}

	store.modelRevision = mustModelRevision(t, "model-revision-2", "org-1")
	view, err := service.ReviseTemplate(context.Background(), input)
	if err != nil {
		t.Fatalf("revise Template: %v", err)
	}
	if store.expectedTemplateRevision != 1 || view.Revision != 2 || view.Name != "Personal V2" {
		t.Fatalf("Template revision CAS was not preserved: expected=%d view=%+v", store.expectedTemplateRevision, view)
	}
}

func TestCatalogReadsCurrentHeadsWithBoundedPagination(t *testing.T) {
	t.Parallel()

	model := ports.ModelProfileRecord{
		ModelProfileID: "model-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Revision: mustModelRevision(t, "model-revision-1", "org-1"),
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
	}
	store := &catalogStoreStub{modelRecord: model, modelPage: []ports.ModelProfileRecord{model}}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(2, 0).UTC()})

	loaded, err := service.GetModelProfile(context.Background(), "org-1", "model-1")
	if err != nil {
		t.Fatalf("get ModelProfile: %v", err)
	}
	if loaded.Model.Model != "deepseek-chat" || !loaded.Enabled {
		t.Fatalf("current ModelProfile view is incomplete: %+v", loaded)
	}
	if _, err := service.GetModelProfile(context.Background(), "org-2", "model-1"); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization ModelProfile read error = %v", err)
	}
	page, err := service.ListModelProfiles(context.Background(), ListCatalogInput{
		OrganizationID: "org-1", AfterID: "model-0", Limit: 20,
	})
	if err != nil {
		t.Fatalf("list ModelProfiles: %v", err)
	}
	if len(page.Items) != 1 || store.listLimit != 20 || store.listAfterID != "model-0" {
		t.Fatalf("pagination was not preserved: page=%+v store=%+v", page, store)
	}
	if _, err := service.ListModelProfiles(context.Background(), ListCatalogInput{
		OrganizationID: "org-1", Limit: 501,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("oversized page error = %v", err)
	}
}

func TestCatalogReadsImmutableHistoricalRevisionsWithOrganizationFence(t *testing.T) {
	t.Parallel()

	historicalModel := mustModelRevisionAt(t, "model-revision-1", "model-1", "org-1", 1, "stage3-v1")
	currentModel := mustModelRevisionAt(t, "model-revision-2", "model-1", "org-1", 2, "stage3-v2")
	historicalTemplate := mustTemplateRevisionAt(t, "template-1", "org-1", 1, "model-revision-1", "historical")
	currentTemplate := mustTemplateRevisionAt(t, "template-1", "org-1", 2, "model-revision-2", "current")
	store := &catalogStoreStub{
		modelRevision: historicalModel,
		modelRecord: ports.ModelProfileRecord{
			ModelProfileID: "model-1", OrganizationID: "org-1", ProfileKey: "stage3",
			DisplayName: "Stage 3", Revision: currentModel, Enabled: true,
			CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
		},
		templateRevision: historicalTemplate,
		templateRecord: ports.TemplateRecord{
			TemplateID: "template-1", OrganizationID: "org-1", TemplateKey: "personal",
			Name: "Personal", Revision: currentTemplate, Enabled: true,
			CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
		},
	}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(2, 0).UTC()})

	model, err := service.GetModelProfileRevision(
		context.Background(), "org-1", "model-revision-1",
	)
	if err != nil {
		t.Fatalf("get historical ModelProfile revision: %v", err)
	}
	if model.Revision != 1 || model.RevisionID != "model-revision-1" || model.Model.Model != "stage3-v1" {
		t.Fatalf("historical ModelProfile view = %+v", model)
	}
	if _, err := service.GetModelProfileRevision(
		context.Background(), "org-2", "model-revision-1",
	); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization ModelProfile revision error = %v", err)
	}

	template, err := service.GetTemplateRevision(context.Background(), "org-1", "template-1", 1)
	if err != nil {
		t.Fatalf("get historical Template revision: %v", err)
	}
	if template.Revision != 1 || template.ModelProfileRevisionID != "model-revision-1" ||
		template.SystemPrompt != "historical" {
		t.Fatalf("historical Template view = %+v", template)
	}
	if _, err := service.GetTemplateRevision(
		context.Background(), "org-2", "template-1", 1,
	); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization Template revision error = %v", err)
	}
}

type catalogStoreStub struct {
	modelRevision            domain.ModelProfileRevision
	modelRecord              ports.ModelProfileRecord
	modelPage                []ports.ModelProfileRecord
	templateRecord           ports.TemplateRecord
	templateRevision         domain.TemplateRevision
	templatePage             []ports.TemplateRecord
	expectedModelRevision    int64
	expectedTemplateRevision int64
	listAfterID              string
	listLimit                int
	modelReplay              ports.ModelProfileRecord
	templateReplay           ports.TemplateRecord
	replayFound              bool
}

func (store *catalogStoreStub) ReplayModelProfileRequest(
	_ context.Context, _ ports.CatalogRequestKind, _ string, _ string,
) (ports.ModelProfileRecord, bool, error) {
	return store.modelReplay, store.replayFound, nil
}

func (store *catalogStoreStub) ReplayTemplateRequest(
	_ context.Context, _ ports.CatalogRequestKind, _ string, _ string,
) (ports.TemplateRecord, bool, error) {
	return store.templateReplay, store.replayFound, nil
}

func (store *catalogStoreStub) PutModelProfile(_ context.Context, record ports.ModelProfileRecord) (ports.ModelProfileRecord, error) {
	store.modelRecord = record
	return record, nil
}

func (store *catalogStoreStub) GetModelProfileRevision(_ context.Context, id string) (domain.ModelProfileRevision, error) {
	if store.modelRevision.ID() == "" || store.modelRevision.ID() != id {
		return domain.ModelProfileRevision{}, ports.ErrNotFound
	}
	return store.modelRevision, nil
}

func (store *catalogStoreStub) GetModelProfile(_ context.Context, id string) (ports.ModelProfileRecord, error) {
	if store.modelRecord.ModelProfileID != id {
		return ports.ModelProfileRecord{}, ports.ErrNotFound
	}
	return store.modelRecord, nil
}

func (store *catalogStoreStub) ReviseModelProfile(
	_ context.Context, expectedRevision int64, record ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	store.expectedModelRevision = expectedRevision
	store.modelRecord = record
	return record, nil
}

func (store *catalogStoreStub) ListModelProfiles(
	_ context.Context, _ string, afterID string, limit int,
) ([]ports.ModelProfileRecord, string, error) {
	store.listAfterID = afterID
	store.listLimit = limit
	return store.modelPage, "", nil
}

func (store *catalogStoreStub) PutTemplate(_ context.Context, record ports.TemplateRecord) (ports.TemplateRecord, error) {
	store.templateRecord = record
	return record, nil
}

func (store *catalogStoreStub) GetTemplate(_ context.Context, id string) (ports.TemplateRecord, error) {
	if store.templateRecord.TemplateID != id {
		return ports.TemplateRecord{}, ports.ErrNotFound
	}
	return store.templateRecord, nil
}

func (store *catalogStoreStub) GetTemplateRevision(
	_ context.Context, id string, revision int64,
) (domain.TemplateRevision, error) {
	candidate := store.templateRevision
	if candidate.Revision() == 0 {
		candidate = store.templateRecord.Revision
	}
	snapshot := candidate.Snapshot()
	if snapshot.TemplateID != id || snapshot.Revision != revision {
		return domain.TemplateRevision{}, ports.ErrNotFound
	}
	return candidate, nil
}

func (store *catalogStoreStub) ReviseTemplate(
	_ context.Context, expectedRevision int64, record ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	store.expectedTemplateRevision = expectedRevision
	store.templateRecord = record
	return record, nil
}

func (store *catalogStoreStub) ListTemplates(
	_ context.Context, _ string, afterID string, limit int,
) ([]ports.TemplateRecord, string, error) {
	store.listAfterID = afterID
	store.listLimit = limit
	return store.templatePage, "", nil
}

type sealerStub struct {
	identity  ports.CredentialIdentity
	plaintext string
	sealed    ports.SealedSecret
	err       error
	calls     int
}

func (sealer *sealerStub) Seal(
	_ context.Context, identity ports.CredentialIdentity, plaintext string,
) (ports.SealedSecret, error) {
	sealer.calls++
	sealer.identity = identity
	sealer.plaintext = plaintext
	return sealer.sealed, sealer.err
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func validModelInput() domain.ModelSpec {
	return domain.ModelSpec{
		BaseURL: "https://api.example.com/v1", Model: "deepseek-chat",
		ContextWindow: 128000, MaxOutputTokens: 8192,
	}
}

func validRuntimeInput() domain.RuntimeSpecInput {
	return domain.RuntimeSpecInput{
		ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Resources: domain.RuntimeResources{
			MemoryBytes: 512 * 1024 * 1024, PIDsLimit: 256, TmpfsBytes: 64 * 1024 * 1024,
		},
	}
}

func mustModelRevision(t *testing.T, id string, organizationID string) domain.ModelProfileRevision {
	return mustModelRevisionAt(t, id, "model-1", organizationID, 1, "deepseek-chat")
}

func mustModelRevisionAt(
	t *testing.T, id, modelProfileID, organizationID string, revisionNumber int64, modelID string,
) domain.ModelProfileRevision {
	t.Helper()
	model := validModelInput()
	model.Model = modelID
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: id, ModelProfileID: modelProfileID, OrganizationID: organizationID,
		Revision: revisionNumber, Model: model, CredentialRef: "credential-1",
		CredentialVersion: "credential-version-1",
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	return revision
}

func mustTemplateRevisionAt(
	t *testing.T, templateID, organizationID string, revisionNumber int64, modelRevisionID, prompt string,
) domain.TemplateRevision {
	t.Helper()
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: templateID, OrganizationID: organizationID, Revision: revisionNumber,
		ModelProfileRevisionID: modelRevisionID, SystemPrompt: prompt, MaxModelRequests: 8,
		ContextPolicyVersion: domain.ContextPolicyV1, Runtime: validRuntimeInput(),
	})
	if err != nil {
		t.Fatalf("create Template revision: %v", err)
	}
	return revision
}
