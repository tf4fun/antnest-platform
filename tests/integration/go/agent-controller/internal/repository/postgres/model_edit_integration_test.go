package postgres

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type afterModelReplayMissStore struct {
	ports.CatalogStore
	afterMiss func()
}

func (store *afterModelReplayMissStore) ReplayModelProfileRequest(ctx context.Context, kind ports.CatalogRequestKind, requestID, fingerprint string) (ports.ModelProfileRecord, bool, error) {
	record, found, err := store.CatalogStore.ReplayModelProfileRequest(ctx, kind, requestID, fingerprint)
	if err == nil && !found {
		store.afterMiss()
	}
	return record, found, err
}

func TestModelEditReplaysCommitAfterInitialLookupAndLaterEdit(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	service := fixtureCatalogService(repository, box, providerTestClock{})
	ctx := context.Background()
	provider, err := service.CreateProviderConnection(ctx, providerTestInput("provider", "org"))
	if err != nil {
		t.Fatal(err)
	}
	parameters := providerTestInput("unused", "org").Models[0].Model
	parameters.Model = "independent"
	created, err := service.CreateModelProfile(ctx, application.CreateModelProfileInput{
		RequestID: "create", OrganizationID: "org", ProviderConnectionID: provider.ConnectionID,
		ProfileKey: "independent", DisplayName: "Original", Model: parameters,
	})
	if err != nil {
		t.Fatal(err)
	}
	edit := application.ReviseModelProfileInput{
		RequestID: "edit", OrganizationID: "org", ModelProfileID: created.ModelProfileID,
		ExpectedVersion: created.Revision, DisplayName: "First", Model: created.Model.Parameters(),
	}
	var committed, latest application.ModelProfileView
	store := &afterModelReplayMissStore{CatalogStore: repository, afterMiss: func() {
		committed, err = service.ReviseModelProfile(ctx, edit)
		if err != nil {
			t.Fatal(err)
		}
		next := edit
		next.RequestID, next.ExpectedVersion, next.DisplayName = "next", committed.Revision, "Latest"
		latest, err = service.ReviseModelProfile(ctx, next)
		if err != nil {
			t.Fatal(err)
		}
	}}
	replayed, err := fixtureCatalogService(store, box, providerTestClock{}).ReviseModelProfile(ctx, edit)
	if err != nil || !reflect.DeepEqual(replayed, committed) {
		t.Fatalf("duplicate command rejected after a later edit: %v", err)
	}
	current, err := service.GetModelProfile(ctx, "org", created.ModelProfileID)
	if err != nil || !reflect.DeepEqual(current, latest) {
		t.Fatalf("duplicate command overwrote current model: %v", err)
	}
}

type modelReadBarrierStore struct {
	ports.CatalogStore
	reads   chan struct{}
	release chan struct{}
}

func (store *modelReadBarrierStore) GetModelProfile(ctx context.Context, id string) (ports.ModelProfileRecord, error) {
	record, err := store.CatalogStore.GetModelProfile(ctx, id)
	if err != nil {
		return record, err
	}
	store.reads <- struct{}{}
	select {
	case <-store.release:
		return record, nil
	case <-ctx.Done():
		return ports.ModelProfileRecord{}, ctx.Err()
	}
}

func TestModelEditConcurrentFormsCommitOnlyOneUpdate(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	service := fixtureCatalogService(repository, box, providerTestClock{})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	var workers sync.WaitGroup
	t.Cleanup(func() { cancel(); workers.Wait() })
	_, err = service.CreateProviderConnection(ctx, providerTestInput("provider", "org"))
	if err != nil {
		t.Fatal(err)
	}
	page, err := service.ListModelProfiles(ctx, application.ListCatalogInput{OrganizationID: "org"})
	if err != nil || len(page.Items) == 0 {
		t.Fatalf("load initial models: %v", err)
	}
	model := page.Items[0]
	store := &modelReadBarrierStore{CatalogStore: repository, reads: make(chan struct{}, 2), release: make(chan struct{})}
	racingService := fixtureCatalogService(store, box, providerTestClock{})
	results := make(chan error, 2)
	for _, requestID := range []string{"edit-one", "edit-two"} {
		workers.Go(func() {
			_, editErr := racingService.ReviseModelProfile(ctx, application.ReviseModelProfileInput{
				RequestID: requestID, OrganizationID: "org", ModelProfileID: model.ModelProfileID,
				ExpectedVersion: model.Revision, DisplayName: requestID, Model: model.Model.Parameters(),
			})
			results <- editErr
		})
	}
	for range 2 {
		select {
		case <-store.reads:
		case <-ctx.Done():
			t.Fatal("concurrent edits did not both read the initial version")
		}
	}
	close(store.release)
	workers.Wait()
	first, second := <-results, <-results
	if first != nil {
		first, second = second, first
	}
	if first != nil || !errors.Is(second, ports.ErrConcurrentChange) {
		t.Fatalf("want one success and one conflict: %v / %v", first, second)
	}
	current, err := service.GetModelProfile(ctx, "org", model.ModelProfileID)
	if err != nil || current.Revision != model.Revision+1 {
		t.Fatalf("concurrent writes advanced more than once: %v", err)
	}
	var receipts int
	var winner string
	err = repository.pool.QueryRow(ctx, `SELECT count(*), min(response_snapshot->>'display_name')
FROM agent_controller.catalog_requests WHERE request_id IN ('edit-one', 'edit-two')`).Scan(&receipts, &winner)
	if err != nil || receipts != 1 || winner != current.DisplayName {
		t.Fatalf("winning edit receipt mismatch: count=%d error=%v", receipts, err)
	}
}
