package application

import (
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Lifecycle-focused tests keep an explicit ready Skill preparation dependency,
// including for empty collections. Tests of preparation failures override it.
func newTestLifecycleService(specs ports.AgentSpecSource, store ports.LifecycleStore, egress ports.EgressClient, runtime ports.RuntimeClient, clock ports.Clock, options ...LifecycleOption) *LifecycleService {
	return NewLifecycleService(specs, store, egress, runtime, clock, append(testSkillPreparationOptions(), options...)...)
}

func newTestLifecycleServiceWithDrainTimeout(specs ports.AgentSpecSource, store ports.LifecycleStore, egress ports.EgressClient, runtime ports.RuntimeClient, clock ports.Clock, drainTimeout time.Duration, options ...LifecycleOption) *LifecycleService {
	return NewLifecycleServiceWithDrainTimeout(specs, store, egress, runtime, clock, drainTimeout, append(testSkillPreparationOptions(), options...)...)
}

func testSkillPreparationOptions() []LifecycleOption {
	return []LifecycleOption{WithSkillPreparation(&skillIntentStub{}, &skillPreparationClientStub{state: "ready"})}
}
