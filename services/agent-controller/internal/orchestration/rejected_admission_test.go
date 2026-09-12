package orchestration

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/mock"
	enums "go.temporal.io/api/enums/v1"
	history "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/mocks"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRejectedAdmissionPreservesCommandIdentity(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "same", true: "conflict"}[changed], func(t *testing.T) {
			original := testCommand()
			payload, err := converter.GetDefaultDataConverter().ToPayloads(original)
			if err != nil {
				t.Fatal(err)
			}
			iterator := &mocks.HistoryEventIterator{}
			iterator.On("HasNext").Return(true).Once()
			iterator.On("Next").Return(&history.HistoryEvent{Attributes: &history.HistoryEvent_WorkflowExecutionStartedEventAttributes{WorkflowExecutionStartedEventAttributes: &history.WorkflowExecutionStartedEventAttributes{Input: payload}}}, nil).Once()
			client := &mocks.Client{}
			client.On("GetWorkflowHistory", mock.Anything, "workflow", "run", false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT).Return(iterator).Once()
			command := original
			if changed {
				command.TemplateID = "different-template"
			}
			err = checkClosedWorkflowCommand(context.Background(), client, "workflow", "run", command)
			if changed && !errors.Is(err, ports.ErrRequestConflict) {
				t.Fatalf("changed command = %v", err)
			}
			if !changed && err != nil {
				t.Fatal(err)
			}
			client.AssertExpectations(t)
			iterator.AssertExpectations(t)
		})
	}
}
