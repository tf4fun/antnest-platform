package application

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var (
	ErrAccessDenied         = errors.New("access denied")
	ErrAgentBusy            = errors.New("agent busy")
	ErrAgentRebuilding      = errors.New("agent rebuilding")
	ErrAgentBuildFailed     = errors.New("agent build failed")
	ErrAdmissionNotFound    = errors.New("admission not found")
	ErrCredentialNotAllowed = errors.New("credential not allowed")
)

const defaultRunAdmissionTTL = 30 * time.Minute

type RunService struct {
	store        ports.RunStore
	credentials  ports.CredentialOpener
	identities   ports.IdentityDirectory
	clock        ports.Clock
	admissionTTL time.Duration
}

type RunServiceOption func(*RunService)

func WithRunIdentityDirectory(directory ports.IdentityDirectory) RunServiceOption {
	return func(service *RunService) {
		service.identities = directory
	}
}

func NewRunService(
	store ports.RunStore,
	credentials ports.CredentialOpener,
	clock ports.Clock,
	admissionTTL time.Duration,
	options ...RunServiceOption,
) *RunService {
	if admissionTTL <= 0 {
		admissionTTL = defaultRunAdmissionTTL
	}
	service := &RunService{
		store: store, credentials: credentials, clock: clock, admissionTTL: admissionTTL,
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service
}

type ResolveAgentAccessInput struct {
	RequestID          string
	AgentAccessSubject string
}

type AgentAccessView struct {
	PrincipalID        string
	AgentID            string
	AccessRevision     string
	PromptCapabilities ports.PromptCapabilities
}

func (service *RunService) ResolveAgentAccess(
	ctx context.Context, input ResolveAgentAccessInput,
) (AgentAccessView, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentAccessSubject) {
		return AgentAccessView{}, fmt.Errorf("%w: Agent access request", ErrInvalidInput)
	}
	record, err := service.store.ResolveAgentAccess(ctx, input.AgentAccessSubject)
	if err != nil {
		return AgentAccessView{}, mapRunError("resolve Agent access", err)
	}
	if !validIdentifier(record.PrincipalID) || !validIdentifier(record.AgentID) ||
		!validIdentifier(record.OrganizationID) || !validIdentifier(record.AccessRevision) {
		return AgentAccessView{}, fmt.Errorf("invalid Agent access resolution")
	}
	if service.identities == nil {
		return AgentAccessView{}, fmt.Errorf(
			"%w: agent owner identity directory is not configured",
			ErrDependencyUnavailable,
		)
	}
	principal, err := service.identities.ResolvePrincipal(
		ctx, record.OrganizationID, record.PrincipalID,
	)
	if err != nil {
		if identityReferenceMissing(err) {
			return AgentAccessView{}, ErrAccessDenied
		}
		return AgentAccessView{}, fmt.Errorf("%w: resolve Agent owner", ErrDependencyUnavailable)
	}
	if principal.UserID != record.PrincipalID || principal.OrganizationID != record.OrganizationID ||
		strings.TrimSpace(principal.MembershipID) == "" || !principal.Active {
		return AgentAccessView{}, ErrAccessDenied
	}
	return AgentAccessView{
		PrincipalID: record.PrincipalID, AgentID: record.AgentID,
		AccessRevision: record.AccessRevision, PromptCapabilities: record.PromptCapabilities,
	}, nil
}

type AcquireRunInput struct {
	RequestID              string
	AgentID                string
	PrincipalID            string
	ExpectedAccessRevision string
	SessionID              string
}

type AcquireRunResult struct {
	AdmissionID              string
	AdmissionDeadline        time.Time
	AgentSpecRevision        string
	ExecutionRevision        string
	RuntimeMCPSourceDigest   string
	AgentExecutionSpecDigest string
	CredentialVersion        string
	Runtime                  ports.AdmittedRuntime
	ExecutionSpec            ports.AdmittedExecutionSpec
}

func (service *RunService) AcquireRun(
	ctx context.Context, input AcquireRunInput,
) (AcquireRunResult, error) {
	if err := validateAcquireRunInput(input); err != nil {
		return AcquireRunResult{}, err
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return AcquireRunResult{}, err
	}
	replay, found, err := service.store.ReplayRunAdmission(ctx, input.RequestID, fingerprint)
	if err != nil {
		return AcquireRunResult{}, mapRunError("replay Run admission", err)
	}
	if found {
		return acquireRunResult(replay, true)
	}
	authorization, err := service.store.ResolveRunAuthorization(
		ctx, input.AgentID, input.PrincipalID, input.ExpectedAccessRevision,
	)
	if err != nil {
		return service.replayRunAfterFailure(
			ctx, input.RequestID, fingerprint, mapRunError("resolve Run authorization", err),
		)
	}
	if !validIdentifier(authorization.OrganizationID) ||
		authorization.OwnerUserID != input.PrincipalID {
		return service.replayRunAfterFailure(
			ctx, input.RequestID, fingerprint, ErrAccessDenied,
		)
	}
	if err := service.requireActiveRunOwner(
		ctx, authorization.OrganizationID, authorization.OwnerUserID,
	); err != nil {
		return service.replayRunAfterFailure(ctx, input.RequestID, fingerprint, err)
	}
	now := service.clock.Now()
	record, replayed, err := service.store.AcquireRun(ctx, ports.AcquireRunRecord{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AdmissionID: derivedID("admission", input.RequestID), AgentID: input.AgentID,
		PrincipalID: input.PrincipalID, ExpectedAccessRevision: input.ExpectedAccessRevision,
		SessionID: input.SessionID, Deadline: now.Add(service.admissionTTL), Now: now,
	})
	if err != nil {
		return AcquireRunResult{}, mapRunError("acquire Run", err)
	}
	return acquireRunResult(record, replayed)
}

func (service *RunService) replayRunAfterFailure(
	ctx context.Context, requestID string, fingerprint string, cause error,
) (AcquireRunResult, error) {
	record, found, err := service.store.ReplayRunAdmission(ctx, requestID, fingerprint)
	if err != nil {
		return AcquireRunResult{}, fmt.Errorf(
			"%w (replay Run admission after failure: %v)", cause, err,
		)
	}
	if found {
		return acquireRunResult(record, true)
	}
	return AcquireRunResult{}, cause
}

func acquireRunResult(record ports.RunAdmissionRecord, replayed bool) (AcquireRunResult, error) {
	if err := validateAdmissionRecord(record, replayed); err != nil {
		return AcquireRunResult{}, err
	}
	snapshot := record.Snapshot
	skills := make([]ports.SkillInstruction, len(snapshot.ExecutionSpec.SkillInstructions))
	copy(skills, snapshot.ExecutionSpec.SkillInstructions)
	snapshot.ExecutionSpec.SkillInstructions = skills
	return AcquireRunResult{
		AdmissionID: record.AdmissionID, AdmissionDeadline: record.Deadline,
		AgentSpecRevision:        snapshot.AgentSpecRevisionID,
		ExecutionRevision:        snapshot.ExecutionRevisionID,
		RuntimeMCPSourceDigest:   snapshot.RuntimeMCPSourceDigest,
		AgentExecutionSpecDigest: snapshot.AgentExecutionSpecDigest,
		CredentialVersion:        snapshot.CredentialVersion, Runtime: snapshot.Runtime,
		ExecutionSpec: snapshot.ExecutionSpec,
	}, nil
}

func (service *RunService) requireActiveRunOwner(
	ctx context.Context, organizationID string, ownerUserID string,
) error {
	if service.identities == nil {
		return fmt.Errorf(
			"%w: agent owner identity directory is not configured",
			ErrDependencyUnavailable,
		)
	}
	principal, err := service.identities.ResolvePrincipal(ctx, organizationID, ownerUserID)
	if err != nil {
		if identityReferenceMissing(err) {
			return ErrAccessDenied
		}
		return fmt.Errorf("%w: resolve Agent owner", ErrDependencyUnavailable)
	}
	if principal.UserID != ownerUserID || principal.OrganizationID != organizationID ||
		strings.TrimSpace(principal.MembershipID) == "" || !principal.Active {
		return ErrAccessDenied
	}
	return nil
}

type ResolveCredentialInput struct {
	RequestID     string
	AdmissionID   string
	CredentialRef string
}

type CredentialView struct {
	CredentialVersion string
	SecretType        string
	Secret            string
}

func (service *RunService) ResolveCredential(
	ctx context.Context, input ResolveCredentialInput,
) (CredentialView, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AdmissionID) ||
		!validIdentifier(input.CredentialRef) {
		return CredentialView{}, fmt.Errorf("%w: credential request", ErrInvalidInput)
	}
	record, err := service.store.GetAdmissionCredential(
		ctx, input.AdmissionID, input.CredentialRef, service.clock.Now(),
	)
	if err != nil {
		return CredentialView{}, mapRunError("resolve admission credential", err)
	}
	if record.SecretType != "bearer" || record.Identity.CredentialRef != input.CredentialRef ||
		!validIdentifier(record.Identity.CredentialVersion) ||
		!validIdentifier(record.Identity.OrganizationID) {
		return CredentialView{}, fmt.Errorf("invalid admission credential record")
	}
	secret, err := service.credentials.Open(ctx, record.Identity, record.Sealed)
	if err != nil {
		return CredentialView{}, fmt.Errorf("open admission credential: %w", err)
	}
	if strings.TrimSpace(secret) == "" {
		return CredentialView{}, fmt.Errorf("admission credential is empty")
	}
	return CredentialView{
		CredentialVersion: record.Identity.CredentialVersion,
		SecretType:        record.SecretType, Secret: secret,
	}, nil
}

type FinishRunInput struct {
	RequestID           string
	AdmissionID         string
	TerminalClass       domain.TerminalClass
	ToolEffectState     domain.ToolEffectState
	UnknownEffectSource domain.UnknownEffectSource
	StopReason          string
	ErrorClass          string
}

type FinishRunResult struct {
	Status         string
	AdmissionState domain.AdmissionState
}

func (service *RunService) FinishRun(
	ctx context.Context, input FinishRunInput,
) (FinishRunResult, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AdmissionID) {
		return FinishRunResult{}, fmt.Errorf("%w: finish Run request", ErrInvalidInput)
	}
	report := domain.TerminalReport{
		Class: input.TerminalClass, ToolEffectState: input.ToolEffectState,
		UnknownEffectSource: input.UnknownEffectSource,
		StopReason:          input.StopReason, ErrorClass: input.ErrorClass,
	}
	state, err := domain.ValidateTerminalReport(report)
	if err != nil {
		return FinishRunResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	now := service.clock.Now()
	var event *ports.RunAdmissionEvent
	if state == domain.AdmissionBlockedUnknownEffect {
		event = &ports.RunAdmissionEvent{
			EventID:   derivedID("event-run-finished", input.RequestID),
			EventType: ports.EventRunAdmissionUnresolved,
			TraceID:   currentTraceID(ctx), Data: map[string]any{
				"terminal_class":        string(report.Class),
				"tool_effect_state":     string(report.ToolEffectState),
				"unknown_effect_source": string(report.UnknownEffectSource),
				"stop_reason":           report.StopReason, "error_class": report.ErrorClass,
			}, OccurredAt: now,
		}
	}
	result, err := service.store.FinishRun(ctx, ports.FinishRunCommand{
		RequestID: input.RequestID, AdmissionID: input.AdmissionID, Report: report,
		Event: event, Now: now,
	})
	if err != nil {
		return FinishRunResult{}, mapRunError("finish Run", err)
	}
	if result.Status != "finished" && result.Status != "already_finished" {
		return FinishRunResult{}, fmt.Errorf("invalid FinishRun status %q", result.Status)
	}
	if result.AdmissionState != state &&
		(state != domain.AdmissionBlockedUnknownEffect || result.AdmissionState != domain.AdmissionReleased) {
		return FinishRunResult{}, fmt.Errorf("FinishRun admission state does not match terminal report")
	}
	return FinishRunResult(result), nil
}

func validateAcquireRunInput(input AcquireRunInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validIdentifier(input.PrincipalID) || !validIdentifier(input.ExpectedAccessRevision) ||
		!validIdentifier(input.SessionID) {
		return fmt.Errorf("%w: acquire Run request", ErrInvalidInput)
	}
	return nil
}

func validateAdmissionRecord(record ports.RunAdmissionRecord, replayed bool) error {
	snapshot := record.Snapshot
	if !validIdentifier(record.AdmissionID) || record.Deadline.IsZero() ||
		record.RuntimeRevision != snapshot.Runtime.RuntimeRevision ||
		(!replayed && record.State != domain.AdmissionActive) ||
		(replayed && record.State != domain.AdmissionActive &&
			record.State != domain.AdmissionReleased &&
			record.State != domain.AdmissionBlockedUnknownEffect) {
		return fmt.Errorf("invalid admitted Run snapshot")
	}
	if err := ports.ValidateRunExecutionSnapshot(snapshot); err != nil {
		return fmt.Errorf("invalid admitted Run snapshot: %w", err)
	}
	return nil
}

func mapRunError(action string, err error) error {
	switch {
	case errors.Is(err, ports.ErrRunAccessDenied):
		return fmt.Errorf("%w: %s", ErrAccessDenied, action)
	case errors.Is(err, ports.ErrNotFound):
		return fmt.Errorf("%w: %s", ErrAgentNotFound, action)
	case errors.Is(err, ports.ErrAgentBusy):
		return fmt.Errorf("%w: %s", ErrAgentBusy, action)
	case errors.Is(err, ports.ErrAgentRebuilding):
		return fmt.Errorf("%w: %s", ErrAgentRebuilding, action)
	case errors.Is(err, ports.ErrAgentBuildFailed):
		return fmt.Errorf("%w: %s", ErrAgentBuildFailed, action)
	case errors.Is(err, ports.ErrAgentNotReady):
		return fmt.Errorf("%w: %s", ErrAgentNotReady, action)
	case errors.Is(err, ports.ErrAdmissionNotFound):
		return fmt.Errorf("%w: %s", ErrAdmissionNotFound, action)
	case errors.Is(err, ports.ErrCredentialNotAllowed):
		return fmt.Errorf("%w: %s", ErrCredentialNotAllowed, action)
	case errors.Is(err, ports.ErrRequestConflict):
		return fmt.Errorf("%w: %s", ErrInvalidInput, action)
	default:
		return fmt.Errorf("%s: %w", action, err)
	}
}
