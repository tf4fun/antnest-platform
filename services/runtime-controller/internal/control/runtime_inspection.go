package control

import (
	"context"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func (s *Service) inspectReadyEnvironment(ctx context.Context, environment deployment.Environment) (deployment.Environment, error) {
	inspection, err := s.inspectExpectedRuntime(ctx, environment)
	if err != nil {
		return deployment.Environment{}, err
	}
	if inspection.Health == deployment.HealthHealthy {
		inspection, err = s.verifier.Verify(ctx, inspection)
		if err != nil {
			return deployment.Environment{}, err
		}
	}
	return environment.WithInspection(inspection), nil
}

func (s *Service) inspectExpectedRuntime(ctx context.Context, environment deployment.Environment) (deployment.Inspection, error) {
	key, ok := environment.RuntimeKey()
	if !ok || deployment.ValidateDigest(environment.SpecDigest) != nil {
		return deployment.Inspection{}, ErrDrift
	}
	inspection, err := s.platform.Inspect(ctx, key)
	if err != nil {
		return deployment.Inspection{}, err
	}
	if inspection.RuntimeKey() != key {
		return deployment.Inspection{}, ErrDrift
	}
	if inspection.PlatformPhase == deployment.PhaseAbsent || inspection.Health == deployment.HealthAbsent {
		if !confirmedRuntimeAbsence(inspection) {
			return deployment.Inspection{}, ErrDrift
		}
		return inspection, nil
	}
	if inspection.SpecDigest != environment.SpecDigest {
		return deployment.Inspection{}, ErrDrift
	}
	if err := s.ValidateRuntimeInspection(ctx, inspection); err != nil {
		return deployment.Inspection{}, err
	}
	return inspection, nil
}

func confirmedRuntimeAbsence(inspection deployment.Inspection) bool {
	return inspection.PlatformPhase == deployment.PhaseAbsent && inspection.Health == deployment.HealthAbsent &&
		inspection.SpecDigest == "" && inspection.MCPEndpoint == "" && inspection.StatusEndpoint == "" &&
		inspection.RuntimeExecutionID == "" && inspection.PlatformResourceID == ""
}
