package acpclient_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestGetRuntimeBarrierSharedResourceIDs(t *testing.T) {
	payload, err := os.ReadFile("../../../../contracts/common/id-vectors.json")
	require.NoError(t, err)
	var vectors map[string]struct {
		Accept []string `json:"accept"`
		Reject []string `json:"reject"`
	}
	require.NoError(t, json.Unmarshal(payload, &vectors))

	for _, kind := range []string{"organizationId", "agentId"} {
		vector, ok := vectors[kind]
		require.True(t, ok, "missing %s vectors", kind)
		require.NotEmpty(t, vector.Accept, "empty %s accept vectors", kind)
		require.NotEmpty(t, vector.Reject, "empty %s reject vectors", kind)
	}

	for _, kind := range []string{"organizationId", "agentId"} {
		for index, value := range vectors[kind].Accept {
			t.Run(kind+"/accept/"+strconv.Itoa(index), func(t *testing.T) {
				query := runtimeBarrierQuery()
				switch kind {
				case "organizationId":
					query.OrganizationID = value
				case "agentId":
					query.AgentID = value
				}
				var calls atomic.Int32
				client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
					calls.Add(1)
					var received ports.RuntimeBarrierQuery
					require.NoError(t, json.NewDecoder(request.Body).Decode(&received))
					require.Equal(t, query, received)
					writeResponse(t, writer, http.StatusOK, runtimeBarrierJSON(t, ports.RuntimeBarrierResult{
						OrganizationID:  query.OrganizationID,
						AgentID:         query.AgentID,
						RuntimeRevision: query.ExpectedRuntimeRevision,
						Barrier:         nil,
					}))
				})
				result, err := client.GetRuntimeBarrier(context.Background(), query)
				require.NoError(t, err)
				require.Equal(t, int32(1), calls.Load())
				require.Equal(t, ports.RuntimeBarrierResult{
					OrganizationID:  query.OrganizationID,
					AgentID:         query.AgentID,
					RuntimeRevision: query.ExpectedRuntimeRevision,
				}, result)
			})
		}
		for index, value := range vectors[kind].Reject {
			t.Run(kind+"/reject/"+strconv.Itoa(index), func(t *testing.T) {
				query := runtimeBarrierQuery()
				switch kind {
				case "organizationId":
					query.OrganizationID = value
				case "agentId":
					query.AgentID = value
				}
				var calls atomic.Int32
				client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
					calls.Add(1)
					writeResponse(t, writer, http.StatusOK, runtimeBarrierJSON(t, ports.RuntimeBarrierResult{}))
				})
				result, err := client.GetRuntimeBarrier(context.Background(), query)
				require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierQuery)
				require.Equal(t, ports.RuntimeBarrierResult{}, result)
				require.Zero(t, calls.Load())
			})
		}
	}
}
