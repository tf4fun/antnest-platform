package platform

import (
	"context"
	"errors"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

var ErrObservationStreamDisconnected = errors.New("platform observation stream disconnected")

// Lifecycle is the deployment-platform capability used by control use cases.
type Lifecycle interface {
	Ready(context.Context) error
	ResolveImage(context.Context, string) (ImageResolution, error)
	DeploymentDigest(deployment.Deployment) (string, error)
	Create(context.Context, deployment.Deployment, string) deployment.EffectOutcome
	Inspect(context.Context, deployment.Key) (deployment.Inspection, error)
	Delete(context.Context, deployment.Key, string) deployment.EffectOutcome
	EnsureStorage(context.Context, string) deployment.EffectOutcome
	VerifyStorage(context.Context, string) deployment.EffectOutcome
	DeleteStorage(context.Context, string) deployment.EffectOutcome
}

// ObservationSource exposes platform inventory and event facts without
// importing Docker or Kubernetes event types.
type ObservationSource interface {
	List(context.Context) ([]deployment.Inspection, error)
	Watch(
		context.Context,
		time.Time,
		func(context.Context) error,
		func(context.Context, deployment.Observation) error,
	) error
}

type Port interface {
	Lifecycle
	ObservationSource
}
