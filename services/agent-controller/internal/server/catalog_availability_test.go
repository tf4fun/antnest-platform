package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type availabilityServiceStub struct {
	catalogServiceStub
	inputs []application.SetCatalogAvailabilityInput
	err    error
}

func (service *catalogServiceStub) SetCatalogAvailability(_ context.Context, input application.SetCatalogAvailabilityInput) (ports.CatalogAvailability, error) {
	return ports.CatalogAvailability{ResourceID: input.ResourceID, Enabled: input.Enabled, UpdatedAt: time.Unix(1, 0).UTC()}, nil
}

func (service *availabilityServiceStub) SetCatalogAvailability(_ context.Context, input application.SetCatalogAvailabilityInput) (ports.CatalogAvailability, error) {
	service.inputs = append(service.inputs, input)
	return ports.CatalogAvailability{ResourceID: input.ResourceID, Enabled: input.Enabled, UpdatedAt: time.Unix(1, 0).UTC()}, service.err
}

func TestCatalogAvailabilityRoutesRequireExplicitBooleans(t *testing.T) {
	for _, route := range []struct {
		path string
		kind ports.CatalogResourceKind
	}{
		{"provider-connections", ports.CatalogProvider}, {"model-profiles", ports.CatalogModel}, {"agent-templates", ports.CatalogTemplate},
	} {
		t.Run(route.path, func(t *testing.T) {
			service := &availabilityServiceStub{}
			boundary, err := NewHandler(service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			path := "/internal/" + route.path + "/resource/availability"
			for _, fields := range []string{`"expected_enabled":true`, `"enabled":false`, `"expected_enabled":null,"enabled":false`, `"expected_enabled":true,"enabled":null`, `"expected_enabled":true,"enabled":false,"extra":1`} {
				response := httptest.NewRecorder()
				boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"request_id":"request","organization_id":"org",`+fields+`}`)))
				require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			}
			require.Empty(t, service.inputs)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"request_id":"request","organization_id":"org","expected_enabled":true,"enabled":false}`)))
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			require.Equal(t, []application.SetCatalogAvailabilityInput{{Kind: route.kind, ResourceID: "resource", OrganizationID: "org", RequestID: "request", ExpectedEnabled: true, Enabled: false}}, service.inputs)
		})
	}
}

func TestCatalogAvailabilityReferenceConflictResponse(t *testing.T) {
	references := []ports.CatalogReference{{Kind: "lifecycle_operation", ResourceID: "operation", AgentID: "agent", OperationID: "operation"}}
	status, payload := publicError(&ports.CatalogReferenceConflict{References: references, Truncated: true})
	require.Equal(t, http.StatusConflict, status)
	require.Equal(t, "resource_in_use", payload.Code)
	require.Equal(t, references, payload.References)
	require.True(t, payload.ReferencesTruncated)
	require.False(t, payload.Retryable)
	encoded, err := json.Marshal(payload)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"references_truncated":true`)
}
