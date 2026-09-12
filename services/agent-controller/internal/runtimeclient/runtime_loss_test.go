package runtimeclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeLossTransportPreservesAbsenceAndObservationKind(t *testing.T) {
	for _, kind := range []string{"runtime_missing", "runtime_deleted"} {
		t.Run(kind, func(t *testing.T) {
			const revision = "rtv_11111111111111111111111111111111"
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				var payload any
				switch request.URL.Path {
				case "/internal/runtime-observations":
					payload = runtimeObservationsDTO{Observations: []runtimeObservationDTO{{
						Sequence: 1, AgentID: "agent-1", RuntimeRevision: revision, Kind: kind, ObservedAt: time.Now().UTC(),
					}}, NextSequence: 1}
				case "/internal/runtimes":
					payload = runtimeListDTO{Runtimes: []runtimeInspectionDTO{{
						AgentID: "agent-1", RuntimeRevision: revision, LifecycleState: "ready", Health: "absent",
					}}}
				default:
					t.Errorf("unexpected request: %s", request.URL.Path)
					response.WriteHeader(http.StatusNotFound)
					return
				}
				if err := json.NewEncoder(response).Encode(payload); err != nil {
					t.Error(err)
				}
			}))
			t.Cleanup(server.Close)
			client, err := New(server.URL, time.Second, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			page, err := client.ListRuntimeObservations(context.Background(), 0, 500)
			if err != nil || len(page.Observations) != 1 || page.Observations[0].Kind != kind || page.NextSequence != 1 {
				t.Fatalf("loss fact dropped or rewritten: %+v error=%v", page, err)
			}
			runtimes, err := client.ListRuntimes(context.Background())
			expected := ports.RuntimeEnvironmentSnapshot{AgentID: "agent-1", RuntimeRevision: revision, LifecycleState: "ready", Health: "absent"}
			if err != nil || len(runtimes) != 1 || runtimes[0] != expected {
				t.Fatalf("loss snapshot dropped or rewritten: %+v error=%v", runtimes, err)
			}
		})
	}
}
