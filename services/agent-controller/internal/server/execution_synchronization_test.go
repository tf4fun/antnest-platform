package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

const executionSynchronizationPath = "/internal/execution-synchronization"

func TestExecutionSynchronizationMissingRecordIsExplicit(t *testing.T) {
	t.Parallel()
	boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	require.NoError(t, err)
	response := httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, executionSynchronizationPath+"?organization_id=org-1", nil))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.JSONEq(t, `{"organization_id":"org-1","synchronization":null}`, response.Body.String())
}

func TestExecutionSynchronizationSchemaRejectsIncompleteOrExecutionFields(t *testing.T) {
	t.Parallel()
	compiler := compileControlSchema(t, filepath.Join(repositoryRoot(t), "contracts/agent-controller/control-api.schema.json"))
	schema, err := compiler.Compile(controlSchemaID + "#/$defs/execution_synchronization")
	require.NoError(t, err)
	for _, payload := range []string{
		`{"organization_id":"org-1"}`,
		`{"organization_id":"org-1","synchronization":null,"ready":true}`,
		`{"organization_id":"org-1","synchronization":{"revision":0,"applied_revision":0,"updated_at":"2026-09-14T12:00:00Z","applied_at":null}}`,
		`{"organization_id":"org-1","synchronization":{"revision":1,"applied_revision":1,"updated_at":"2026-09-14T12:00:00Z","applied_at":null}}`,
		`{"organization_id":"org-1","synchronization":{"revision":1,"applied_revision":0,"updated_at":"2026-09-14T12:00:00Z","applied_at":"2026-09-14T12:00:00Z"}}`,
		`{"organization_id":"org-1","synchronization":{"revision":1,"applied_revision":0,"updated_at":"invalid","applied_at":null}}`,
		`{"organization_id":"org-1","synchronization":{"revision":1,"applied_revision":0,"updated_at":"2026-09-14T12:00:00Z","applied_at":null,"active_run":"run-1"}}`,
	} {
		var value any
		require.NoError(t, json.Unmarshal([]byte(payload), &value))
		require.Error(t, schema.Validate(value), payload)
	}
}

func TestExecutionSynchronizationHTTPMatchesContract(t *testing.T) {
	t.Parallel()
	compiler := compileControlSchema(t, filepath.Join(repositoryRoot(t), "contracts/agent-controller/control-api.schema.json"))
	now := time.Unix(100, 0).UTC()
	for _, state := range []*application.ExecutionSynchronizationState{
		nil,
		{Revision: 8, UpdatedAt: now},
		{Revision: 8, AppliedRevision: 7, UpdatedAt: now, AppliedAt: &now},
		{Revision: 8, AppliedRevision: 8, UpdatedAt: now, AppliedAt: &now},
	} {
		configuration := &agentConfigurationServiceStub{synchronization: state}
		boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, configuration,
			&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
		require.NoError(t, err)
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, executionSynchronizationPath+"?organization_id=org-1", nil))
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		require.Equal(t, "org-1", configuration.synchronizationOrganization)
		require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
		assertControlResponseSchema(t, compiler, "control-api.schema.json#/$defs/execution_synchronization", response.Body.Bytes())
	}
}

func TestExecutionSynchronizationHTTPRejectsAmbiguousQuery(t *testing.T) {
	t.Parallel()
	for _, query := range []string{"organization_id=", "organization_id=a&organization_id=b", "organization_id=a&refresh=true", "organization_id=%zz"} {
		t.Run(query, func(t *testing.T) {
			configuration := &agentConfigurationServiceStub{}
			boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, configuration,
				&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, executionSynchronizationPath+"?"+query, nil))
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Empty(t, configuration.synchronizationOrganization)
		})
	}
}

func TestExecutionSynchronizationHTTPReadErrorsDoNotExposeStorage(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		cause  error
		status int
	}{
		{context.DeadlineExceeded, http.StatusServiceUnavailable},
		{context.Canceled, http.StatusServiceUnavailable},
		{errors.New("SELECT private_column FROM execution_configuration_sync"), http.StatusInternalServerError},
	} {
		t.Run(test.cause.Error(), func(t *testing.T) {
			boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{err: test.cause},
				&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, executionSynchronizationPath+"?organization_id=org-1", nil))
			require.Equal(t, test.status, response.Code, response.Body.String())
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			require.NotContains(t, response.Body.String(), "synchronization")
			require.NotContains(t, response.Body.String(), "private_column")
		})
	}
}
