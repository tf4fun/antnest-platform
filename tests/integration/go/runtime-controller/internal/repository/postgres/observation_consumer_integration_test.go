//go:build antnest_observation_consumer

package postgres

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/observationfixture"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/rpc"
)

func TestRepositoryCommittedObservationControllerConsumer(t *testing.T) {
	testCompletionObservationConsumer(t, func(t *testing.T, store *Repository) observationOrderReader {
		health := &observation.Health{}
		health.MarkJournal(true)
		health.MarkNotifications(true)
		service, err := control.NewService(store, store, health, followerReadinessPlatform{},
			followerReadinessVerifier{}, time.Now, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte(observationConsumerToken))
		receiver, err := serviceauth.ParseReceiver("runtime-controller",
			[]byte(fmt.Sprintf(`{"agent-controller":["sha256:%x"]}`, digest)), false)
		if err != nil {
			t.Fatal(err)
		}
		handler, err := rpc.NewHandler(service, observation.NewHub(), time.Second, time.Second, rpc.Security{Authentication: receiver})
		if err != nil {
			t.Fatal(err)
		}
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		client, err := observationfixture.NewClient(server.URL, &http.Client{Transport: observationConsumerTransport{base: server.Client().Transport}})
		if err != nil {
			t.Fatal(err)
		}
		return func(ctx context.Context, after uint64, limit int) (observationOrderPage, error) {
			page, err := client.ListRuntimeObservations(ctx, after, limit)
			result := observationOrderPage{NextSequence: page.NextSequence}
			for _, fact := range page.Observations {
				result.Observations = append(result.Observations, deployment.Observation{
					Sequence: fact.Sequence, AgentID: fact.AgentID, RuntimeRevision: deployment.RuntimeRevision(fact.RuntimeRevision),
					Kind: deployment.ObservationKind(fact.Kind), RuntimeExecutionID: fact.RuntimeExecutionID, ObservedAt: fact.ObservedAt,
				})
			}
			return result, err
		}
	})
}

const observationConsumerToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

type observationConsumerTransport struct{ base http.RoundTripper }

func (transport observationConsumerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	cloned := request.Clone(request.Context())
	cloned.Header.Set(serviceauth.Header, "Bearer "+observationConsumerToken)
	return transport.base.RoundTrip(cloned)
}
