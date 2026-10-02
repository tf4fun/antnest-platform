package rpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestStatusReportsMonitorOutageAndRecoveryWithRequiredField(t *testing.T) {
	health := &observation.Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	store := &monitorReadinessStore{}
	service, err := control.NewService(store, store, health, monitorReadinessPlatform{},
		monitorReadinessVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	handler := newTestHandler(t, service)
	var schema controlSchema
	readJSONFile(t, filepath.Join(serviceRoot(t), "api/control-api.schema.json"), &schema)
	for _, ready := range []bool{false, true, false} {
		health.MarkMonitor(ready)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
		wantCode, wantStatus := http.StatusServiceUnavailable, "not_ready"
		if ready {
			wantCode, wantStatus = http.StatusOK, "ready"
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != wantCode || body["status"] != wantStatus || body["ready"] != ready || body["monitor_ready"] != ready {
			t.Fatalf("monitor %t: HTTP %d body=%s", ready, response.Code, response.Body.String())
		}
		for _, field := range []string{"live", "database_ready", "platform_ready", "observation_ready"} {
			if body[field] != true {
				t.Fatalf("monitor outage changed %s: %s", field, response.Body.String())
			}
		}
		assertRequiredFields(t, schema, "readiness", body)
	}
}

type monitorReadinessStore struct {
	repository.Store
	repository.MutationLocker
}

func (*monitorReadinessStore) Ready(context.Context) error { return nil }

type monitorReadinessPlatform struct{ platform.Lifecycle }

func (monitorReadinessPlatform) Ready(context.Context) error { panic("status must not probe Docker") }

type monitorReadinessVerifier struct{ control.RuntimeVerifier }
