package control

import (
	"context"
	"fmt"

	"github.com/opencontainers/go-digest"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

func (s *Service) prepareBuildImage(ctx context.Context, operation *deployment.Operation, configuration deployment.Configuration) error {
	image, err := s.platform.ResolveImage(ctx, configuration.ImageRef)
	if err != nil {
		return err
	}
	operation.ImageReference = configuration.ImageRef
	operation.ImageID = image.ImageRef
	physical, err := deploymentForOperation(configuration, *operation)
	if err != nil {
		return err
	}
	operation.SpecDigest, err = s.platform.DeploymentDigest(physical)
	return err
}

func deploymentForOperation(configuration deployment.Configuration, operation deployment.Operation) (deployment.Deployment, error) {
	identity, err := digest.Parse(operation.ImageID)
	if err != nil || identity.Algorithm() != digest.SHA256 || operation.ImageReference != configuration.ImageRef {
		return deployment.Deployment{}, fmt.Errorf("%w: build image identity is missing or inconsistent", ErrRequestConflict)
	}
	physical, err := configuration.Resolve(operation.AgentID, operation.Generation)
	if err != nil {
		return deployment.Deployment{}, err
	}
	physical.ImageReference = operation.ImageReference
	physical.ImageRef = operation.ImageID
	if physical.PreparedSkills != nil && operation.PreparedSetID > 0 {
		physical.PreparedMaterialization = &skillset.PreparedMaterialization{
			SetID: operation.PreparedSetID,
			Key: skillset.SetKey{Scope: physical.PreparedSkills.Scope, OrganizationID: physical.PreparedSkills.OrganizationID,
				AgentID: operation.AgentID, SkillSetDigest: physical.PreparedSkills.SkillSetDigest,
				LayoutVersion: physical.PreparedSkills.LayoutVersion, Materialization: operation.PreparedMaterialization},
			VolumeName: operation.PreparedVolumeName, ManifestDigest: operation.PreparedManifestDigest,
		}
	}
	return physical, nil
}
