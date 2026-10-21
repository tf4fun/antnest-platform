package postgres

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/rpc"
)

const observationFloorHTTPToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

func TestRepositoryObservationRetentionFloorThroughAuthenticatedHTTP(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	store.maxObservationRows = 2
	epoch := observationTestEpoch(t, store, ctx)
	if _, err := database.ExecContext(ctx, `
INSERT INTO runtime_controller.observations (sequence,agent_id,runtime_revision,generation,spec_digest,kind,source,observed_at,recorded_at)
VALUES (10,'','',0,'','reconciled','http-floor-fixture',NOW(),NOW()),
       (20,'','',0,'','reconciled','http-floor-fixture',NOW(),NOW()),
       (30,'','',0,'','reconciled','http-floor-fixture',NOW(),NOW())`); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.PruneObservationBatch(ctx, epoch); err != nil || removed != 1 {
		t.Fatalf("count pruning removed %d rows, want 1: %v", removed, err)
	}
	health := &observation.Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	service, err := control.NewService(store, store, health, followerReadinessPlatform{},
		followerReadinessVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(observationFloorHTTPToken))
	receiver, err := serviceauth.ParseReceiver("runtime-controller",
		[]byte(fmt.Sprintf(`{"agent-controller":["sha256:%x"]}`, digest)), false)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := rpc.NewHandler(service, observation.NewHub(), time.Second, time.Second,
		rpc.Security{Authentication: receiver})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := &http.Client{Transport: server.Client().Transport, Timeout: 2 * time.Second}
	get := func(path string, expectedStatus int) observationFloorHTTPResponse {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set(serviceauth.Header, "Bearer "+observationFloorHTTPToken)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := response.Body.Close(); err != nil {
				t.Error(err)
			}
		}()
		if response.StatusCode != expectedStatus {
			t.Fatalf("GET %s returned HTTP %d, want %d", path, response.StatusCode, expectedStatus)
		}
		var body observationFloorHTTPResponse
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	expired := get("/internal/runtime-observations?after_sequence=9", http.StatusGone)
	if expired.Code != "observation_cursor_expired" || expired.ResetSequence != 30 {
		t.Fatalf("cursor below the pruned prefix did not expire at sequence 30: %+v", expired)
	}
	retained := get("/internal/runtime-observations?after_sequence=10", http.StatusOK)
	if len(retained.Observations) != 2 || retained.Observations[0].Sequence != 20 ||
		retained.Observations[1].Sequence != 30 {
		t.Fatalf("sparse sequences expired the valid floor cursor: %+v", retained)
	}
	if _, err := database.ExecContext(ctx,
		"UPDATE runtime_controller.observations SET recorded_at=NOW()-INTERVAL '2 hours'"); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.PruneObservationBatch(ctx, epoch); err != nil || removed != 2 {
		t.Fatalf("age pruning removed %d rows, want 2: %v", removed, err)
	}
	expired = get("/internal/runtime-observations?after_sequence=29", http.StatusGone)
	if expired.Code != "observation_cursor_expired" || expired.ResetSequence != 30 {
		t.Fatalf("empty journal forgot its expiration floor: %+v", expired)
	}
	current := get("/internal/runtime-observations?after_sequence=30", http.StatusOK)
	if current.Observations == nil || len(current.Observations) != 0 || current.LatestSequence != 30 {
		t.Fatalf("empty journal rejected or forgot the valid floor cursor: %+v", current)
	}
	bootstrap := get("/internal/runtime-observations?after_sequence=0", http.StatusOK)
	if bootstrap.Observations == nil || len(bootstrap.Observations) != 0 || bootstrap.LatestSequence != 30 {
		t.Fatalf("empty journal lost bootstrap cursor support: %+v", bootstrap)
	}
	watch := get("/internal/runtime-observations/watch?after_sequence=29", http.StatusGone)
	if watch.Code != "observation_cursor_expired" || watch.ResetSequence != 30 {
		t.Fatalf("Watch did not reject its expired initial cursor: %+v", watch)
	}
}

type observationFloorHTTPResponse struct {
	Code          string `json:"code"`
	ResetSequence uint64 `json:"reset_sequence"`
	Observations  []struct {
		Sequence uint64 `json:"sequence"`
	} `json:"observations"`
	LatestSequence uint64 `json:"latest_sequence"`
}
