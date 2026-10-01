package orchestration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type Service struct {
	*application.LifecycleService
	client client.Client
}

func NewService(lifecycle *application.LifecycleService, temporalClient client.Client) *Service {
	service := &Service{LifecycleService: lifecycle, client: temporalClient}
	return service
}

func (service *Service) CreateAgent(ctx context.Context, command application.CreateAgentInput) (application.CreateAgentResult, error) {
	command.Name = strings.TrimSpace(command.Name)
	return startWorkflow(ctx, service.client, "agent-create/"+command.RequestID, CreateAgentWorkflow, command, service.ReplayCreateAgent)
}

func startWorkflow[I any, R any](ctx context.Context, temporalClient client.Client, workflowID string, workflow interface{}, command I, replay func(context.Context, I) (R, bool, error)) (R, error) {
	var result R
	// A retained business record remains authoritative after engine history expires.
	if result, found, err := replay(ctx, command); found || err != nil {
		return result, err
	}
	payload, err := json.Marshal(command)
	if err != nil {
		return result, fmt.Errorf("encode lifecycle command: %w", err)
	}
	fingerprint := sha256.Sum256(payload)
	updateID := hex.EncodeToString(fingerprint[:])
	start := temporalClient.NewWithStartWorkflowOperation(client.StartWorkflowOptions{
		ID: workflowID, TaskQueue: TaskQueue,
		WorkflowIDConflictPolicy: enums.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
		WorkflowIDReusePolicy:    enums.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
	}, workflow, command)
	handle, err := temporalClient.UpdateWithStartWorkflow(ctx, client.UpdateWithStartWorkflowOptions{
		StartWorkflowOperation: start,
		UpdateOptions: client.UpdateWorkflowOptions{
			UpdateID: updateID, UpdateName: admissionUpdate,
			WaitForStage: client.WorkflowUpdateStageCompleted, Args: []interface{}{command},
		},
	})
	var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &alreadyStarted) {
		// A fast completion may race the initial database read. Never start a second workflow.
		if result, found, replayErr := replay(ctx, command); found || replayErr != nil {
			return result, replayErr
		}
		if err := checkClosedWorkflowCommand(ctx, temporalClient, workflowID, alreadyStarted.RunId, command); err != nil {
			return result, err
		}
		handle = temporalClient.GetWorkflowUpdateHandle(client.GetWorkflowUpdateHandleOptions{
			WorkflowID: workflowID, RunID: alreadyStarted.RunId, UpdateID: updateID,
		})
		err = nil
	}
	if err != nil {
		return result, publicError(err)
	}
	if err := handle.Get(ctx, &result); err != nil {
		return result, publicError(err)
	}
	return result, nil
}

var admissionErrors = []struct {
	code string
	err  error
}{
	{"invalid_input", application.ErrInvalidInput},
	{"invalid_reference", application.ErrInvalidReference},
	{"not_found", ports.ErrNotFound},
	{"agent_not_found", application.ErrAgentNotFound},
	{"disabled_reference", ports.ErrDisabledReference},
	{"request_conflict", ports.ErrRequestConflict},
	{"lifecycle_conflict", application.ErrLifecycleConflict},
	{"agent_not_ready", application.ErrAgentNotReady},
}

func activityError(err error) error {
	for _, failure := range admissionErrors {
		if errors.Is(err, failure.err) {
			return temporal.NewNonRetryableApplicationError(err.Error(), failure.code, nil)
		}
	}
	return err
}

func publicError(err error) error {
	var failure *temporal.ApplicationError
	if errors.As(err, &failure) {
		for _, mapping := range admissionErrors {
			if failure.Type() == mapping.code {
				return fmt.Errorf("%w: %s", mapping.err, failure.Message())
			}
		}
	}
	return fmt.Errorf("%w: workflow admission: %v", application.ErrDependencyUnavailable, err)
}

// Failed admission has no business row. The retained workflow input is its
// immutable idempotency record; do not query a non-existent Update for a new body.
func checkClosedWorkflowCommand[I any](ctx context.Context, temporalClient client.Client, workflowID, runID string, command I) error {
	history := temporalClient.GetWorkflowHistory(ctx, workflowID, runID, false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	if !history.HasNext() {
		return fmt.Errorf("%w: workflow admission history is unavailable", application.ErrDependencyUnavailable)
	}
	event, err := history.Next()
	if err != nil {
		return publicError(err)
	}
	started := event.GetWorkflowExecutionStartedEventAttributes()
	if started == nil {
		return fmt.Errorf("%w: workflow admission history has no start", application.ErrDependencyUnavailable)
	}
	var original I
	if err := converter.GetDefaultDataConverter().FromPayloads(started.Input, &original); err != nil {
		return publicError(err)
	}
	originalJSON, err := json.Marshal(original)
	if err != nil {
		return publicError(err)
	}
	commandJSON, err := json.Marshal(command)
	if err != nil {
		return publicError(err)
	}
	if sha256.Sum256(originalJSON) != sha256.Sum256(commandJSON) {
		return ports.ErrRequestConflict
	}
	return nil
}
