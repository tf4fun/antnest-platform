package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/runtime-egress/internal/protocol"
)

type fakeService struct {
	ensured  protocol.Reservation
	released protocol.GenerationKey
}

func (f *fakeService) Ensure(_ context.Context, value protocol.Reservation) error {
	f.ensured = value
	return nil
}

func (f *fakeService) Release(_ context.Context, key protocol.GenerationKey) error {
	f.released = key
	return nil
}

func TestEnsureReservation(t *testing.T) {
	service := &fakeService{}
	handler, err := New(service, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	body := `{"runtime_instance_id":"runtime-1","generation":2,"agent_id":"agent-1","virtual_ip":"100.64.0.2","allocator_epoch":1,"network_mode":"unrestricted","policy_epoch":3,"policy_revision":3}`
	request := httptest.NewRequest(http.MethodPut, "/internal/v1/reservations/runtime-1/2", strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if service.ensured.AgentID != "agent-1" || service.ensured.Generation != 2 {
		t.Fatalf("Ensure() = %+v", service.ensured)
	}
}
