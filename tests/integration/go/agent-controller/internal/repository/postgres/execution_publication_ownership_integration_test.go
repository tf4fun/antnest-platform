package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const publicationOwnershipOrganization = "publication-owner-a"
const publicationOwnershipOtherOrganization = "publication-owner-b"

// Embedding preserves the real repository's publication capabilities. Only the
// source-read entry is observed, before it can capture a stale MVCC snapshot.
type publicationOwnershipReadStore struct {
	*Repository
	entered chan struct{}
	reads   atomic.Int64
}

func (store *publicationOwnershipReadStore) ReadExecutionSource(ctx context.Context, organization string) (ports.ExecutionSource, error) {
	if organization == publicationOwnershipOrganization {
		store.reads.Add(1)
		select {
		case store.entered <- struct{}{}:
		default:
		}
	}
	return store.Repository.ReadExecutionSource(ctx, organization)
}

type publicationOwnershipOpener struct {
	base  publicationCredentialOpener
	opens atomic.Int64
}

func (opener *publicationOwnershipOpener) Open(ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret) (string, error) {
	if identity.OrganizationID == publicationOwnershipOrganization {
		opener.opens.Add(1)
	}
	return opener.base.Open(ctx, identity, sealed)
}

type publicationOwnershipResult struct {
	acknowledgement ports.ExecutionAcknowledgement
	err             error
}

type publicationOwnershipTask struct {
	done chan publicationOwnershipResult
}

type publicationOwnershipFixture struct {
	ctx               context.Context
	observer          *Repository
	secondStore       *publicationOwnershipReadStore
	secondOpener      *publicationOwnershipOpener
	firstPublisher    *application.ExecutionPublisher
	secondPublisher   *application.ExecutionPublisher
	catalog           *application.CatalogService
	connectionID      string
	credentialVersion string
	firstApplication  string
	secondApplication string
	finish            chan struct{}
	releaseOnce       sync.Once
	firstSent         chan receivedExecutionSnapshot
	secondSent        chan receivedExecutionSnapshot
	httpErrors        chan error
	workers           sync.WaitGroup
	tasks             []*publicationOwnershipTask
}

func newPublicationOwnershipFixture(t *testing.T, failFirstSend bool) *publicationOwnershipFixture {
	t.Helper()
	observer := providerTestRepository(t)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	t.Cleanup(cancel)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := fixtureCatalogService(observer, box, providerTestClock{})
	connection, err := catalog.CreateProviderConnection(ctx, providerTestInput("publication-owner-create-a", publicationOwnershipOrganization))
	require.NoError(t, err)
	_, err = catalog.CreateProviderConnection(ctx, providerTestInput("publication-owner-create-b", publicationOwnershipOtherOrganization))
	require.NoError(t, err)
	identity := fmt.Sprintf("publication-owner-%d", time.Now().UnixNano())
	firstApplication, secondApplication := identity+"-a", identity+"-b"
	open := func(applicationName string) *Repository {
		databaseURL := observer.pool.Config().ConnString()
		configuration, failure := url.Parse(databaseURL)
		if failure == nil && (configuration.Scheme == "postgres" || configuration.Scheme == "postgresql") {
			query := configuration.Query()
			query.Set("application_name", applicationName)
			configuration.RawQuery = query.Encode()
			databaseURL = configuration.String()
		} else {
			// The generated name is also a safe unquoted libpq keyword value.
			databaseURL += " application_name=" + applicationName
		}
		repository, failure := Open(ctx, databaseURL)
		require.NoError(t, failure)
		t.Cleanup(repository.Close)
		return repository
	}
	firstRepository := open(firstApplication)
	secondRepository := open(secondApplication)
	require.NotSame(t, firstRepository, secondRepository)
	require.NotSame(t, firstRepository.pool, secondRepository.pool)
	fixture := &publicationOwnershipFixture{
		ctx: ctx, observer: observer,
		secondStore:  &publicationOwnershipReadStore{Repository: secondRepository, entered: make(chan struct{}, 1)},
		secondOpener: &publicationOwnershipOpener{base: publicationCredentialOpener{repository: secondRepository, box: box}},
		catalog:      catalog, connectionID: connection.ConnectionID, credentialVersion: connection.CredentialVersion,
		firstApplication: firstApplication, secondApplication: secondApplication,
		finish: make(chan struct{}), firstSent: make(chan receivedExecutionSnapshot, 8), secondSent: make(chan receivedExecutionSnapshot, 8),
		httpErrors: make(chan error, 16),
	}
	handler := func(repository *Repository, sent chan<- receivedExecutionSnapshot, held bool) http.HandlerFunc {
		return func(response http.ResponseWriter, request *http.Request) {
			if request.Method != http.MethodPost || request.URL.Path != "/rpc/agent-acp/apply-execution-snapshot" {
				fixture.httpErrors <- fmt.Errorf("unexpected publication route %s %s", request.Method, request.URL.Path)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			var snapshot receivedExecutionSnapshot
			if failure := json.NewDecoder(request.Body).Decode(&snapshot); failure != nil {
				fixture.httpErrors <- fmt.Errorf("decode publication: %w", failure)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			// Publication ownership may use a dedicated lock connection, but the
			// ordinary source pool and its read transaction must already be free.
			if acquired := repository.pool.Stat().AcquiredConns(); acquired != 0 {
				fixture.httpErrors <- fmt.Errorf("HTTP publication retained %d ordinary database connections", acquired)
				response.WriteHeader(http.StatusInternalServerError)
				return
			}
			select {
			case sent <- snapshot:
			case <-request.Context().Done():
				return
			}
			if held {
				select {
				case <-fixture.finish:
				case <-request.Context().Done():
					return
				}
				if failFirstSend {
					http.Error(response, "synthetic publication failure", http.StatusServiceUnavailable)
					return
				}
			}
			response.Header().Set("Content-Type", "application/json")
			failure := json.NewEncoder(response).Encode(ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision})
			if failure != nil && request.Context().Err() == nil {
				fixture.httpErrors <- fmt.Errorf("encode publication acknowledgement: %w", failure)
			}
		}
	}
	firstServer := httptest.NewServer(handler(firstRepository, fixture.firstSent, true))
	secondServer := httptest.NewServer(handler(secondRepository, fixture.secondSent, false))
	t.Cleanup(func() {
		fixture.release()
		cancel()
		fixture.workers.Wait()
		firstServer.Close()
		secondServer.Close()
		for _, task := range fixture.tasks {
			select {
			case <-task.done:
			default:
			}
		}
		for _, repository := range []*Repository{firstRepository, secondRepository} {
			if acquired := repository.pool.Stat().AcquiredConns(); acquired != 0 {
				t.Errorf("publication cleanup retained %d ordinary connections", acquired)
			}
		}
		for {
			select {
			case failure := <-fixture.httpErrors:
				t.Error(failure)
			default:
				return
			}
		}
	})
	firstClient, err := acpclient.New(firstServer.URL, 20*time.Second, firstServer.Client())
	require.NoError(t, err)
	secondClient, err := acpclient.New(secondServer.URL, 20*time.Second, secondServer.Client())
	require.NoError(t, err)
	fixture.firstPublisher = application.NewExecutionPublisher(firstRepository, publicationCredentialOpener{repository: firstRepository, box: box}, firstClient)
	fixture.secondPublisher = application.NewExecutionPublisher(fixture.secondStore, fixture.secondOpener, secondClient)
	return fixture
}

func (fixture *publicationOwnershipFixture) release() {
	fixture.releaseOnce.Do(func() { close(fixture.finish) })
}

func (fixture *publicationOwnershipFixture) start(ctx context.Context, work func(context.Context) (ports.ExecutionAcknowledgement, error)) *publicationOwnershipTask {
	task := &publicationOwnershipTask{done: make(chan publicationOwnershipResult, 1)}
	fixture.tasks = append(fixture.tasks, task)
	fixture.workers.Add(1)
	go func() {
		defer fixture.workers.Done()
		acknowledgement, err := work(ctx)
		task.done <- publicationOwnershipResult{acknowledgement: acknowledgement, err: err}
	}()
	return task
}

func (fixture *publicationOwnershipFixture) publish(ctx context.Context, publisher *application.ExecutionPublisher, organization string) *publicationOwnershipTask {
	return fixture.start(ctx, func(ctx context.Context) (ports.ExecutionAcknowledgement, error) {
		return publisher.Publish(ctx, organization)
	})
}

func (fixture *publicationOwnershipFixture) await(t *testing.T, task *publicationOwnershipTask) publicationOwnershipResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(fixture.ctx, 5*time.Second)
	defer cancel()
	select {
	case result := <-task.done:
		return result
	case <-ctx.Done():
		t.Fatal("publication task did not finish", ctx.Err())
		return publicationOwnershipResult{}
	}
}

func (fixture *publicationOwnershipFixture) snapshot(t *testing.T, sent <-chan receivedExecutionSnapshot) receivedExecutionSnapshot {
	t.Helper()
	ctx, cancel := context.WithTimeout(fixture.ctx, 5*time.Second)
	defer cancel()
	select {
	case snapshot := <-sent:
		return snapshot
	case <-ctx.Done():
		t.Fatal("publication did not reach the real HTTP peer", ctx.Err())
		return receivedExecutionSnapshot{}
	}
}

func (fixture *publicationOwnershipFixture) awaitDatabaseWait(t *testing.T, task *publicationOwnershipTask) {
	t.Helper()
	ctx, cancel := context.WithTimeout(fixture.ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-fixture.secondStore.entered:
			t.Fatal("second publisher read its source before acquiring organization publication ownership")
		case result := <-task.done:
			t.Fatalf("second publisher returned before a PostgreSQL ownership wait: %v", result.err)
		default:
		}
		var waiting bool
		err := fixture.observer.pool.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity waiter
 JOIN pg_stat_activity holder ON holder.pid=ANY(pg_blocking_pids(waiter.pid))
 WHERE waiter.datname=current_database() AND holder.datname=current_database()
   AND waiter.application_name=$1 AND holder.application_name=$2
   AND waiter.wait_event_type='Lock'
)`, fixture.secondApplication, fixture.firstApplication).Scan(&waiting)
		require.NoError(t, err)
		if waiting {
			require.Zero(t, fixture.secondStore.reads.Load(), "ownership must precede the source snapshot")
			require.Zero(t, fixture.secondOpener.opens.Load(), "a waiting publisher must not decrypt credentials")
			require.Empty(t, fixture.secondSent, "a waiting publisher must not dispatch HTTP")
			return
		}
		select {
		case <-fixture.secondStore.entered:
			t.Fatal("second publisher read its source before acquiring organization publication ownership")
		case result := <-task.done:
			t.Fatalf("second publisher returned before a PostgreSQL ownership wait: %v", result.err)
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("second publisher never entered a real PostgreSQL ownership wait", ctx.Err())
		}
	}
}

func TestExecutionPublicationOwnershipSerializesRepositoriesWithoutBlockingMutations(t *testing.T) {
	fixture := newPublicationOwnershipFixture(t, false)
	first := fixture.publish(fixture.ctx, fixture.firstPublisher, publicationOwnershipOrganization)
	initial := fixture.snapshot(t, fixture.firstSent)
	require.Equal(t, publicationOwnershipOrganization, initial.OrganizationID)
	require.EqualValues(t, 1, initial.Revision)
	second := fixture.publish(fixture.ctx, fixture.secondPublisher, publicationOwnershipOrganization)
	fixture.awaitDatabaseWait(t, second)

	start := make(chan struct{})
	mutation := fixture.start(fixture.ctx, func(ctx context.Context) (ports.ExecutionAcknowledgement, error) {
		select {
		case <-start:
		case <-ctx.Done():
			return ports.ExecutionAcknowledgement{}, ctx.Err()
		}
		_, err := fixture.catalog.RotateProviderCredential(ctx, application.RotateProviderCredentialInput{
			RequestID: "publication-owner-rotate", OrganizationID: publicationOwnershipOrganization,
			ConnectionID: fixture.connectionID, ExpectedVersion: fixture.credentialVersion,
			Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic-publication-owner-current"},
		})
		return ports.ExecutionAcknowledgement{}, err
	})
	other := fixture.start(fixture.ctx, func(ctx context.Context) (ports.ExecutionAcknowledgement, error) {
		select {
		case <-start:
		case <-ctx.Done():
			return ports.ExecutionAcknowledgement{}, ctx.Err()
		}
		return fixture.secondPublisher.Publish(ctx, publicationOwnershipOtherOrganization)
	})
	close(start)
	require.NoError(t, fixture.await(t, mutation).err, "publication ownership must not lock catalog mutations")
	otherResult := fixture.await(t, other)
	require.NoError(t, otherResult.err, "one organization's publication must not block another")
	require.Equal(t, publicationOwnershipOtherOrganization, otherResult.acknowledgement.OrganizationID)
	otherSnapshot := fixture.snapshot(t, fixture.secondSent)
	require.Equal(t, publicationOwnershipOtherOrganization, otherSnapshot.OrganizationID)
	require.Zero(t, fixture.secondStore.reads.Load())
	require.Zero(t, fixture.secondOpener.opens.Load())
	fixture.release()
	require.NoError(t, fixture.await(t, first).err)
	currentResult := fixture.await(t, second)
	require.NoError(t, currentResult.err)
	require.EqualValues(t, 2, currentResult.acknowledgement.AppliedRevision)
	current := fixture.snapshot(t, fixture.secondSent)
	require.Equal(t, publicationOwnershipOrganization, current.OrganizationID)
	require.EqualValues(t, 2, current.Revision)
	require.Len(t, current.Providers, 1)
	require.Equal(t, "synthetic-publication-owner-current", current.Providers[0].Credential.Secret)
	require.EqualValues(t, 1, fixture.secondStore.reads.Load())
	require.EqualValues(t, 1, fixture.secondOpener.opens.Load())
	state, err := fixture.observer.GetExecutionSynchronization(fixture.ctx, publicationOwnershipOrganization)
	require.NoError(t, err)
	require.EqualValues(t, 2, state.Revision)
	require.Equal(t, state.Revision, state.AppliedRevision)
	require.Empty(t, fixture.firstSent)
	require.Empty(t, fixture.secondSent)
}

func TestExecutionPublicationOwnershipCanceledWaiterDoesNotReadOrPublish(t *testing.T) {
	fixture := newPublicationOwnershipFixture(t, false)
	first := fixture.publish(fixture.ctx, fixture.firstPublisher, publicationOwnershipOrganization)
	_ = fixture.snapshot(t, fixture.firstSent)
	ctx, cancel := context.WithCancel(fixture.ctx)
	defer cancel()
	waiting := fixture.publish(ctx, fixture.secondPublisher, publicationOwnershipOrganization)
	fixture.awaitDatabaseWait(t, waiting)
	cancel()
	result := fixture.await(t, waiting)
	require.ErrorIs(t, result.err, context.Canceled)
	require.Empty(t, result.acknowledgement)
	require.Zero(t, fixture.secondStore.reads.Load())
	require.Zero(t, fixture.secondOpener.opens.Load())
	require.Empty(t, fixture.secondSent)
	fixture.release()
	require.NoError(t, fixture.await(t, first).err)
	resumed := fixture.await(t, fixture.publish(fixture.ctx, fixture.secondPublisher, publicationOwnershipOrganization))
	require.NoError(t, resumed.err)
	require.EqualValues(t, 1, resumed.acknowledgement.AppliedRevision)
	_ = fixture.snapshot(t, fixture.secondSent)
	require.EqualValues(t, 1, fixture.secondStore.reads.Load())
	require.EqualValues(t, 1, fixture.secondOpener.opens.Load())
}

func TestExecutionPublicationOwnershipSendFailureReleasesWaitingPublisher(t *testing.T) {
	fixture := newPublicationOwnershipFixture(t, true)
	first := fixture.publish(fixture.ctx, fixture.firstPublisher, publicationOwnershipOrganization)
	_ = fixture.snapshot(t, fixture.firstSent)
	second := fixture.publish(fixture.ctx, fixture.secondPublisher, publicationOwnershipOrganization)
	fixture.awaitDatabaseWait(t, second)
	state, err := fixture.observer.GetExecutionSynchronization(fixture.ctx, publicationOwnershipOrganization)
	require.NoError(t, err)
	require.Zero(t, state.AppliedRevision)
	fixture.release()
	failed := fixture.await(t, first)
	require.Error(t, failed.err)
	require.Empty(t, failed.acknowledgement)
	recovered := fixture.await(t, second)
	require.NoError(t, recovered.err)
	require.EqualValues(t, 1, recovered.acknowledgement.AppliedRevision)
	snapshot := fixture.snapshot(t, fixture.secondSent)
	require.Equal(t, publicationOwnershipOrganization, snapshot.OrganizationID)
	require.EqualValues(t, 1, snapshot.Revision)
	require.EqualValues(t, 1, fixture.secondStore.reads.Load())
	require.EqualValues(t, 1, fixture.secondOpener.opens.Load())
	state, err = fixture.observer.GetExecutionSynchronization(fixture.ctx, publicationOwnershipOrganization)
	require.NoError(t, err)
	require.EqualValues(t, 1, state.AppliedRevision)
	require.Empty(t, fixture.firstSent)
	require.Empty(t, fixture.secondSent)
}
