package postgres

import (
	"context"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

// Existing lifecycle scenarios keep real PostgreSQL preparation intents while
// simulating an RC ready receipt. Docker E2E covers the actual RC materialization.
func newIntegratedLifecycleService(specs ports.AgentSpecSource, store ports.LifecycleStore, egress ports.EgressClient, runtime ports.RuntimeClient, clock ports.Clock, options ...application.LifecycleOption) *application.LifecycleService {
	intents, ok := store.(ports.SkillPreparationIntentStore)
	if !ok {
		panic("integration lifecycle store must persist Skill preparation intents")
	}
	all := append([]application.LifecycleOption{application.WithSkillPreparation(intents, readySkillPreparationClient{})}, options...)
	return application.NewLifecycleService(specs, store, egress, runtime, clock, all...)
}

type readySkillPreparationClient struct{}

func (readySkillPreparationClient) PrepareSkillSet(_ context.Context, requestID, agentID string, request ports.SkillPreparationRequest) (ports.SkillPreparationReceipt, error) {
	return ports.SkillPreparationReceipt{RequestID: requestID, AgentID: agentID, OrganizationID: request.OrganizationID,
		OwnerOperationID: request.OwnerOperationID, State: "ready",
		PreparedSkillSet:    &ports.PreparedSkillSet{SkillSetDigest: request.SkillSetDigest, LayoutVersion: request.LayoutVersion},
		PreparedReferenceID: "psr_11111111111111111111111111111111"}, nil
}

func (readySkillPreparationClient) GetSkillPreparation(context.Context, string, string, string) (ports.SkillPreparationReceipt, error) {
	return ports.SkillPreparationReceipt{}, fmt.Errorf("unexpected Skill preparation status read")
}

func (readySkillPreparationClient) ReleaseSkillPreparation(context.Context, string, string, string, string, string) error {
	return nil
}
