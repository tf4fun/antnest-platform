package postgres

import (
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestBuildAgentQueryStatementUsesDirectParameterizedPredicates(t *testing.T) {
	t.Parallel()

	statement, arguments, err := buildAgentQueryStatement(ports.AgentQuery{
		OrganizationID: "org-1", LifecycleState: domain.AgentAvailable,
		AfterCreatedAt: time.Unix(1, 0).UTC(), AfterAgentID: "agent-1", Limit: 25,
	})
	if err != nil {
		t.Fatalf("build Agent query: %v", err)
	}
	for _, fragment := range []string{
		"organization_id = $1", "lifecycle_state = $2", "lifecycle_state <> 'deleted'",
		"(created_at, id) > ($3, $4)", "LIMIT $5",
	} {
		if !strings.Contains(statement, fragment) {
			t.Fatalf("statement lacks %q: %s", fragment, statement)
		}
	}
	if strings.Contains(statement, " OR ") || strings.Contains(statement, "owner_user_id =") {
		t.Fatalf("statement contains an inactive or generic predicate: %s", statement)
	}
	if len(arguments) != 5 || arguments[0] != "org-1" || arguments[1] != domain.AgentAvailable ||
		arguments[3] != "agent-1" || arguments[4] != 25 {
		t.Fatalf("arguments = %#v", arguments)
	}
}

func TestBuildAgentQueryStatementIncludesDeletedOnlyWhenRequested(t *testing.T) {
	t.Parallel()

	statement, _, err := buildAgentQueryStatement(ports.AgentQuery{IncludeDeleted: true, Limit: 10})
	if err != nil {
		t.Fatalf("build Agent audit query: %v", err)
	}
	if strings.Contains(statement, "lifecycle_state <>") || strings.Contains(statement, "\nWHERE ") {
		t.Fatalf("audit query unexpectedly filters deleted Agents: %s", statement)
	}
}

func TestBuildAgentQueryStatementRejectsIncompleteCursor(t *testing.T) {
	t.Parallel()

	_, _, err := buildAgentQueryStatement(ports.AgentQuery{AfterAgentID: "agent-1", Limit: 10})
	if err == nil {
		t.Fatal("incomplete Agent cursor was accepted")
	}
}

func TestBuildWorkspaceAgentQueryScopesAccessAndDerivesOccupancy(t *testing.T) {
	t.Parallel()

	createdAt := time.Unix(2, 0).UTC()
	statement, arguments, err := buildWorkspaceAgentQueryStatement(ports.WorkspaceAgentQuery{
		OrganizationID: "org-1", PrincipalID: "user-1",
		AfterCreatedAt: createdAt, AfterAgentID: "agent-1", Limit: 25,
	})
	if err != nil {
		t.Fatalf("build workspace Agent query: %v", err)
	}
	for _, fragment := range []string{
		"access.principal_id = $2", "access.active", "agent.organization_id = $1",
		"candidate.state IN ('active', 'blocked_unknown_effect')",
		"(agent.created_at, agent.id) > ($3, $4)", "LIMIT $5",
	} {
		if !strings.Contains(statement, fragment) {
			t.Fatalf("statement lacks %q: %s", fragment, statement)
		}
	}
	if len(arguments) != 5 || arguments[0] != "org-1" || arguments[1] != "user-1" ||
		arguments[2] != createdAt || arguments[3] != "agent-1" || arguments[4] != 25 {
		t.Fatalf("arguments = %#v", arguments)
	}
}

func TestBuildWorkspaceAgentQueryRejectsIncompleteScope(t *testing.T) {
	t.Parallel()

	for _, query := range []ports.WorkspaceAgentQuery{
		{OrganizationID: "org-1", PrincipalID: "user-1"},
		{PrincipalID: "user-1", Limit: 1},
		{OrganizationID: "org-1", Limit: 1},
		{OrganizationID: "org-1", PrincipalID: "user-1", AfterAgentID: "agent-1", Limit: 1},
	} {
		if _, _, err := buildWorkspaceAgentQueryStatement(query); err == nil {
			t.Fatalf("invalid workspace query was accepted: %+v", query)
		}
	}
}
