package application

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleReliabilityEventsRemainReadable(t *testing.T) {
	for _, eventType := range []string{ports.EventAgentLifecycleCancelled, ports.EventAgentLifecycleQuarantineCleared, ports.EventAgentGCScheduled} {
		t.Run(eventType, func(t *testing.T) {
			record := testAgentEvent(11, "event-reliability", "agent-1", 2)
			record.EventType = eventType
			record.OperationRequestID = "request-lifecycle"
			store := &agentEventStoreStub{events: []ports.AgentEventRecord{record}}
			agents := &agentQueryStoreStub{record: queryAgentRecord("agent-1", "user-1", "available", time.Unix(1, 0).UTC())}
			service := NewEventService(store, store, agents)
			page, err := service.ListAgentEvents(t.Context(), ListAgentEventsInput{OrganizationID: "org-1", AgentID: "agent-1", AfterSequence: 10})
			require.NoError(t, err)
			require.EqualValues(t, 11, page.NextSequence)
			require.Len(t, page.Events, 1)
			require.Equal(t, eventType, page.Events[0].EventType)
			require.Equal(t, record.OperationRequestID, page.Events[0].OperationRequestID)
			require.Equal(t, record.Data, page.Events[0].Data)
			global, err := service.ListGlobalEvents(t.Context(), ListEventsInput{OrganizationID: "org-1", AfterSequence: 10})
			require.NoError(t, err)
			require.Equal(t, page, global)
		})
	}
}

func TestLifecycleReliabilityEventsKeepStrictSchemaAdmission(t *testing.T) {
	for _, eventType := range []string{ports.EventAgentLifecycleCancelled, ports.EventAgentLifecycleQuarantineCleared, ports.EventAgentGCScheduled, "undocumented_event"} {
		record := testAgentEvent(11, "event-reliability", "agent-1", 2)
		record.EventType, record.SchemaVersion = eventType, 2
		store := &agentEventStoreStub{events: []ports.AgentEventRecord{record}}
		service := NewEventService(store, store, &agentQueryStoreStub{})
		_, err := service.ListGlobalEvents(t.Context(), ListEventsInput{AfterSequence: 10})
		require.ErrorIs(t, err, ErrQueryContract)
	}
}
