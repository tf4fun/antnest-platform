package postgres

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestWorkspaceMetadataDoesNotDependOnRunStorage(t *testing.T) {
	repository := providerTestRepository(t)
	ctx := t.Context()
	now := time.Unix(1000, 0).UTC()
	for _, fixture := range []struct {
		id, organization, owner string
		desired                 domain.DesiredState
		lifecycle               domain.AgentState
		binding, active         bool
	}{
		{"a-ready", "org", "owner", domain.DesiredEnabled, domain.AgentCreated, true, true},
		{"b-disabled", "org", "owner", domain.DesiredDisabled, domain.AgentCreated, true, true},
		{"c-waiting", "org", "owner", domain.DesiredEnabled, domain.AgentNotCreated, true, true},
		{"d-other-org", "other-org", "owner", domain.DesiredEnabled, domain.AgentCreated, true, true},
		{"e-other-owner", "org", "other-owner", domain.DesiredEnabled, domain.AgentCreated, true, true},
		{"f-inactive", "org", "owner", domain.DesiredEnabled, domain.AgentCreated, true, false},
		{"g-unbound", "org", "owner", domain.DesiredEnabled, domain.AgentCreated, false, false},
		{"h-deleting", "org", "owner", domain.DesiredDeleted, domain.AgentCreated, true, true},
		{"i-deleted", "org", "owner", domain.DesiredDeleted, domain.AgentDeleted, true, true},
		{"j-revoked", "org", "owner", domain.DesiredEnabled, domain.AgentCreated, true, true},
	} {
		insertQueryAgent(t, ctx, repository, fixture.id, fixture.organization, fixture.owner, fixture.desired, fixture.lifecycle, now)
		if fixture.binding {
			_, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.agent_access_bindings
 (agent_id, principal_id, access_revision, active, created_at, updated_at)
 VALUES ($1,$2,$3,$4,$5,$5)`, fixture.id, fixture.owner, "access-"+fixture.id, fixture.active, now)
			require.NoError(t, err)
		}
	}
	_, err := repository.pool.Exec(ctx, "UPDATE agent_controller.agents SET identity_revocation_sequence=1 WHERE id='j-revoked'")
	require.NoError(t, err)
	assertManagementOnlySchema(t, repository)
	queries := application.NewAgentQueryService(repository)
	_, err = repository.pool.Exec(ctx, `UPDATE agent_controller.agents SET
 activation_state=CASE WHEN lifecycle_state<>'created' THEN '' WHEN id='b-disabled' THEN 'disabled' ELSE 'enabled' END,
 runtime_state=CASE WHEN id='a-ready' THEN 'available' WHEN id='b-disabled' THEN 'exited' ELSE 'waiting' END`)
	require.NoError(t, err)
	input := application.ListWorkspaceAgentsInput{RequestID: "list", OrganizationID: "org", PrincipalID: "owner", Limit: 2}
	page, err := queries.ListWorkspaceAgents(ctx, input)
	require.NoError(t, err)
	require.Len(t, page.Items, 2)
	require.Equal(t, "a-ready", page.Items[0].AgentID)
	require.Equal(t, "b-disabled", page.Items[1].AgentID)
	require.Equal(t, domain.AgentCreated, page.Items[0].LifecycleState)
	require.Equal(t, domain.ActivationEnabled, page.Items[0].ActivationState)
	require.Equal(t, domain.RuntimeAvailable, page.Items[0].RuntimeState)
	require.Equal(t, domain.ActivationDisabled, page.Items[1].ActivationState)
	require.Equal(t, domain.RuntimeExited, page.Items[1].RuntimeState)
	require.NotEmpty(t, page.NextCursor)
	input.Cursor = page.NextCursor
	page, err = queries.ListWorkspaceAgents(ctx, input)
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	require.Equal(t, "c-waiting", page.Items[0].AgentID)
	require.Equal(t, domain.AgentNotCreated, page.Items[0].LifecycleState)
	require.Empty(t, page.Items[0].ActivationState)
	require.Equal(t, domain.RuntimeWaiting, page.Items[0].RuntimeState)
	require.Empty(t, page.NextCursor)
	input.Cursor, input.OrganizationID, input.PrincipalID = "", "other-org", "owner"
	page, err = queries.ListWorkspaceAgents(ctx, input)
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	require.Equal(t, "d-other-org", page.Items[0].AgentID)
	input.OrganizationID, input.PrincipalID = "org", "other-owner"
	page, err = queries.ListWorkspaceAgents(ctx, input)
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	require.Equal(t, "e-other-owner", page.Items[0].AgentID)
	input.PrincipalID = "unknown"
	page, err = queries.ListWorkspaceAgents(ctx, input)
	require.NoError(t, err)
	require.Empty(t, page.Items)
	require.Empty(t, page.NextCursor)
}

func TestControllerNotificationsExcludeRunOccupancy(t *testing.T) {
	repository := providerTestRepository(t)
	var count int
	err := repository.pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_trigger AS trigger
 JOIN pg_class AS relation ON relation.oid=trigger.tgrelid
 JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
 WHERE namespace.nspname='agent_controller' AND relation.relname='run_admissions'
 AND NOT trigger.tgisinternal`).Scan(&count)
	require.NoError(t, err)
	require.Zero(t, count, "Controller journal notifications must not depend on Run state")
}
