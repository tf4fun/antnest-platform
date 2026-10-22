package orchestration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// EnsureRuntimeBarrierRecoveryStarted proves that Temporal accepted the durable
// original command. Business admission alone cannot prove this: its transaction
// deliberately precedes workflow dispatch. The caller acknowledges pending work
// separately, only after this method succeeds.
func (service *Service) EnsureRuntimeBarrierRecoveryStarted(ctx context.Context, receipt ports.RuntimeBarrierRecoveryReceipt) error {
	command, err := runtimeBarrierRecoveryWorkflowCommand(receipt)
	if err != nil {
		return err
	}
	if service == nil || service.client == nil {
		return application.ErrDependencyUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	workflowID := "agent-rebuild/" + command.RequestID
	run, err := service.client.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID: workflowID, TaskQueue: TaskQueue,
		WorkflowIDConflictPolicy:                 enums.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
		WorkflowIDReusePolicy:                    enums.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: true,
	}, LifecycleWorkflow, command)
	if cancelled := ctx.Err(); cancelled != nil {
		return errors.Join(err, cancelled)
	}
	var runID string
	var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
	switch {
	case errors.As(err, &alreadyStarted):
		// A retained closed execution is sufficient, provided its original input
		// matches. No old admission Update needs to exist or remain readable.
		runID = alreadyStarted.RunId
	case err != nil:
		return runtimeBarrierRecoveryStartError("start", err)
	case run == nil:
		return runtimeBarrierRecoveryStartError("missing execution", nil)
	default:
		if run.GetID() != workflowID {
			return ports.ErrRequestConflict
		}
		runID = run.GetRunID()
	}
	if runID == "" {
		return runtimeBarrierRecoveryStartError("missing run identity", nil)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	description, err := service.client.DescribeWorkflowExecution(ctx, workflowID, runID)
	if cancelled := ctx.Err(); cancelled != nil {
		return errors.Join(err, cancelled)
	}
	if err != nil {
		return runtimeBarrierRecoveryStartError("describe", err)
	}
	info := description.GetWorkflowExecutionInfo()
	if info.GetExecution().GetWorkflowId() != workflowID || info.GetExecution().GetRunId() != runID ||
		info.GetType().GetName() != "LifecycleWorkflow" || info.GetTaskQueue() != TaskQueue ||
		description.GetExecutionConfig().GetTaskQueue().GetName() != TaskQueue {
		return ports.ErrRequestConflict
	}
	switch info.GetStatus() {
	case enums.WORKFLOW_EXECUTION_STATUS_RUNNING, enums.WORKFLOW_EXECUTION_STATUS_COMPLETED,
		enums.WORKFLOW_EXECUTION_STATUS_FAILED, enums.WORKFLOW_EXECUTION_STATUS_CANCELED,
		enums.WORKFLOW_EXECUTION_STATUS_TERMINATED, enums.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW,
		enums.WORKFLOW_EXECUTION_STATUS_TIMED_OUT:
	default:
		return runtimeBarrierRecoveryStartError("unknown execution status", nil)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	history := service.client.GetWorkflowHistory(ctx, workflowID, runID, false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	if err := ctx.Err(); err != nil {
		return err
	}
	if history == nil {
		return runtimeBarrierRecoveryStartError("missing history", nil)
	}
	hasNext := history.HasNext()
	if err := ctx.Err(); err != nil {
		return err
	}
	if !hasNext {
		return runtimeBarrierRecoveryStartError("empty history", nil)
	}
	event, err := history.Next()
	if cancelled := ctx.Err(); cancelled != nil {
		return errors.Join(err, cancelled)
	}
	if err != nil {
		return runtimeBarrierRecoveryStartError("read history", err)
	}
	started := event.GetWorkflowExecutionStartedEventAttributes()
	if event.GetEventId() != 1 || event.GetEventType() != enums.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED ||
		started == nil || started.GetWorkflowType().GetName() != "LifecycleWorkflow" ||
		started.GetTaskQueue().GetName() != TaskQueue || len(started.GetInput().GetPayloads()) != 1 {
		return runtimeBarrierRecoveryStartError("invalid original input", nil)
	}
	var original application.LifecycleCommand
	if err := converter.GetDefaultDataConverter().FromPayloads(started.Input, &original); err != nil {
		return runtimeBarrierRecoveryStartError("decode original input", err)
	}
	if original != command {
		return ports.ErrRequestConflict
	}
	return ctx.Err()
}

func runtimeBarrierRecoveryStartError(stage string, cause error) error {
	if cause != nil {
		return fmt.Errorf("%w: Runtime barrier workflow %s: %w", application.ErrDependencyUnavailable, stage, cause)
	}
	return fmt.Errorf("%w: Runtime barrier workflow %s", application.ErrDependencyUnavailable, stage)
}

func runtimeBarrierRecoveryWorkflowCommand(receipt ports.RuntimeBarrierRecoveryReceipt) (application.LifecycleCommand, error) {
	fact, command := receipt.Fact, receipt.Command
	if fact.Barrier == nil || !fact.Matches(ports.RuntimeBarrierQuery{
		OrganizationID: fact.OrganizationID, AgentID: fact.AgentID, ExpectedRuntimeRevision: fact.RuntimeRevision,
	}) || !domain.ValidRuntimeBarrierPolicyIdentifier(fact.OrganizationID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(fact.AgentID) ||
		command.OrganizationID != fact.OrganizationID || command.AgentID != fact.AgentID ||
		command.ActorPrincipalID != "agent-controller" || !domain.ValidRuntimeBarrierPolicyIdentifier(command.TemplateID) || command.TemplateRevision < 1 ||
		receipt.Policy.OrganizationID != fact.OrganizationID || receipt.Policy.Validate() != nil || receipt.Policy.Mode != "auto" ||
		receipt.AcceptedAt.IsZero() || !receipt.CooldownUntil.Equal(receipt.AcceptedAt.Add(time.Duration(receipt.Policy.CooldownMS)*time.Millisecond)) {
		return application.LifecycleCommand{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	if err != nil || command.RequestID != requestID {
		return application.LifecycleCommand{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	// The port command preserves the existing Rebuild six-field JSON shape and
	// field order. Workflow-only Kind and revocation data never enter this hash.
	payload, err := json.Marshal(command)
	if err != nil {
		return application.LifecycleCommand{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	digest := sha256.Sum256(payload)
	if receipt.RequestFingerprint != hex.EncodeToString(digest[:]) {
		return application.LifecycleCommand{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	return application.LifecycleCommand{
		Kind: domain.OperationRebuild, RequestID: command.RequestID, OrganizationID: command.OrganizationID,
		ActorPrincipalID: command.ActorPrincipalID, AgentID: command.AgentID,
		TemplateID: command.TemplateID, TemplateRevision: command.TemplateRevision,
	}, nil
}
