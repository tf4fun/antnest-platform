package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/runtime-provider-docker/internal/protocol"
)

type fakeDriver struct {
	ensured protocol.EnsureRequest
}

func (f *fakeDriver) Ensure(_ context.Context, input protocol.EnsureRequest) protocol.DriverResult {
	f.ensured = input
	return protocol.DriverResult{Outcome: protocol.EffectOutcome{State: protocol.EffectCompleted}, ContainerID: "container-1"}
}

func (*fakeDriver) Stop(context.Context, protocol.RuntimeTarget) protocol.DriverResult {
	return protocol.DriverResult{Outcome: protocol.EffectOutcome{State: protocol.EffectCompleted}}
}

func (*fakeDriver) Remove(context.Context, protocol.RuntimeTarget, bool) protocol.DriverResult {
	return protocol.DriverResult{Outcome: protocol.EffectOutcome{State: protocol.EffectCompleted}}
}

func TestEnsureDispatchesCompleteSpec(t *testing.T) {
	driver := &fakeDriver{}
	handler, err := New(driver, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	body := `{"agent_id":"agent-1","generation":2,"runtime_instance_id":"runtime-2","image_ref":"antnest/runtime:test","network_mode":"restricted","network_policy_epoch":1,"tunnel_ipv4":"100.64.0.2","allocator_epoch":1,"advertised_endpoint":"172.30.255.2:8091","egress_endpoint":"172.30.255.3:8092","management_network":"antnest-runtime-management","dns_ipv4":"100.64.0.1","bootstrap_token":"0123456789abcdef0123456789abcdef"}`
	request := httptest.NewRequest(http.MethodPut, "/internal/v1/runtimes/agent-1", strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if driver.ensured.RuntimeInstanceID != "runtime-2" || driver.ensured.EgressEndpoint == "" {
		t.Fatalf("Ensure() = %+v", driver.ensured)
	}
}
