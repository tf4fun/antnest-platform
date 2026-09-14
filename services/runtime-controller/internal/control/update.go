package control

import (
	"context"
	"errors"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func (s *Service) updateRuntime(
	ctx context.Context, operation deployment.Operation, physical deployment.Deployment,
) (deployment.Operation, error) {
	source, ok := operation.SourceKey()
	if !ok || deployment.ValidateDigest(operation.SourceSpecDigest) != nil {
		return s.unresolvedUpdate(ctx, operation, "runtime_drift")
	}
	inspection, err := s.platform.Inspect(ctx, source)
	if errors.Is(err, deployment.ErrIdentityConflict) {
		// The Agent-named resource may already be this operation's target.
		// Create reuses only an exact identity and verifies retained storage.
		return s.createRuntime(ctx, operation, physical, true)
	}
	if err != nil {
		return s.unresolvedUpdate(ctx, operation, "platform_unavailable")
	}
	if inspection.RuntimeKey() == source && inspection.PlatformPhase == deployment.PhaseAbsent &&
		inspection.Health == deployment.HealthAbsent && inspection.SpecDigest == "" {
		return s.createRuntime(ctx, operation, physical, true)
	}
	if !matchesUpdateSource(operation, inspection) {
		return s.unresolvedUpdate(ctx, operation, "runtime_drift")
	}
	outcome := s.deleteSource(ctx, operation)
	if outcome.State != deployment.EffectCompleted {
		// A substep's not_started result cannot erase effects of prior attempts
		// or changes between Inspect and Delete. Re-prove the source after failure.
		retained := outcome.State == deployment.EffectNotStarted && outcome.Code != "runtime_drift" &&
			s.updateSourceStillPresent(ctx, operation)
		if retained {
			operation.Inspection = nil
		}
		return s.finishFromEffect(ctx, operation, outcome, !retained)
	}
	return s.createRuntime(ctx, operation, physical, true)
}

func matchesUpdateSource(operation deployment.Operation, inspection deployment.Inspection) bool {
	source, ok := operation.SourceKey()
	if !ok || inspection.RuntimeKey() != source || inspection.SpecDigest != operation.SourceSpecDigest {
		return false
	}
	switch inspection.PlatformPhase {
	case deployment.PhaseCreated, deployment.PhaseRunning, deployment.PhaseExited:
		return true
	default:
		return false
	}
}

func (s *Service) updateSourceStillPresent(ctx context.Context, operation deployment.Operation) bool {
	source, ok := operation.SourceKey()
	if !ok {
		return false
	}
	inspection, err := s.platform.Inspect(ctx, source)
	return err == nil && matchesUpdateSource(operation, inspection) && inspection.PlatformPhase == deployment.PhaseRunning
}

func (s *Service) unresolvedUpdate(
	ctx context.Context, operation deployment.Operation, code string,
) (deployment.Operation, error) {
	return s.finishFromEffect(ctx, operation, deployment.EffectOutcome{
		State: deployment.EffectUnknown, Code: code,
	}, true)
}
