package control

import (
	"context"
	"errors"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	repositoryport "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func (s *Service) inspectProvisionedEnvironment(ctx context.Context, environment deployment.Environment) (deployment.Environment, error) {
	inspection, err := s.inspectExpectedRuntime(ctx, environment)
	if err != nil {
		return deployment.Environment{}, err
	}
	if inspection.Health == deployment.HealthHealthy {
		verified, verifyErr := s.verifier.Verify(ctx, inspection)
		if errors.Is(verifyErr, deployment.ErrIdentityConflict) {
			return deployment.Environment{}, ErrDrift
		}
		if ctx.Err() != nil {
			return deployment.Environment{}, ctx.Err()
		}
		if verifyErr != nil {
			inspection.Health = deployment.HealthUnknown
			inspection.RuntimeExecutionID = ""
			inspection.Reason = "runtime_status_unverified"
			inspection.DiagnosticSummary = "Runtime status could not be verified"
			return environment.WithInspection(inspection), nil
		}
		inspection = verified
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
	if s.instanceCredentials != nil && inspection.RuntimeEndpoint != "" {
		store, ok := s.repository.(repositoryport.InstanceCredentialStore)
		if !ok {
			return deployment.Inspection{}, ErrConnectionUnavailable
		}
		creator, err := store.GenerationOperation(ctx, key)
		if err != nil || creator.SpecDigest != environment.SpecDigest || creator.InstanceAuthentication == nil || creator.InstanceAuthentication.Tunnel == nil || !instanceauth.ValidTunnelKeyID(creator.InstanceAuthentication.Tunnel.KeyID) {
			return deployment.Inspection{}, ErrConnectionUnavailable
		}
		inspection.TunnelKeyID = creator.InstanceAuthentication.Tunnel.KeyID
	}
	return inspection, nil
}

func confirmedRuntimeAbsence(inspection deployment.Inspection) bool {
	return inspection.PlatformPhase == deployment.PhaseAbsent && inspection.Health == deployment.HealthAbsent &&
		inspection.SpecDigest == "" && inspection.MCPEndpoint == "" && inspection.StatusEndpoint == "" &&
		inspection.RuntimeEndpoint == "" &&
		inspection.RuntimeExecutionID == "" && inspection.PlatformResourceID == ""
}
