package application

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func modelCallPolicyProjectionSource(organizationID string, revision int64) ports.ExecutionSource {
	return ports.ExecutionSource{OrganizationID: organizationID, Revision: revision,
		Providers: []ports.ProviderConnectionRecord{}, Models: []ports.ModelProfileRecord{}, Agents: []ports.ExecutionAgentSource{}}
}

func modelCallPolicyProjectionBudget() *domain.OrganizationBudget {
	return &domain.OrganizationBudget{Revision: 3, UnknownCost: "deny",
		RunCaps: domain.RunBudget{MaxInputTokens: modelCallPolicyInt64(1000), MaxCostUSDMicros: modelCallPolicyInt64(50)},
		Daily:   domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64(40), HardCostUSDMicros: modelCallPolicyInt64(60)},
		Monthly: domain.PeriodCaps{HardCostUSDMicros: modelCallPolicyInt64(900)}}
}

func TestOrganizationBudgetProjectionOmitsAbsentPolicy(t *testing.T) {
	t.Parallel()
	snapshot, err := BuildExecutionSnapshot(t.Context(), modelCallPolicyProjectionSource("org-1", 1), nil)
	require.NoError(t, err)
	require.Nil(t, snapshot.OrganizationBudget)
	encoded, err := json.Marshal(snapshot)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "organization_budget",
		"legacy publications keep the field absent rather than emitting a default")
	require.NoError(t, snapshot.Validate())
}

func TestOrganizationBudgetProjectionClonesCompletePersistedPolicy(t *testing.T) {
	t.Parallel()
	source := modelCallPolicyProjectionSource("org-1", 4)
	source.OrganizationBudget = modelCallPolicyProjectionBudget()
	snapshot, err := BuildExecutionSnapshot(t.Context(), source, nil)
	require.NoError(t, err)
	require.NotNil(t, snapshot.OrganizationBudget)
	require.Equal(t, *source.OrganizationBudget, *snapshot.OrganizationBudget)
	require.NotSame(t, source.OrganizationBudget, snapshot.OrganizationBudget)
	for _, pair := range [][2]*int64{
		{source.OrganizationBudget.RunCaps.MaxInputTokens, snapshot.OrganizationBudget.RunCaps.MaxInputTokens},
		{source.OrganizationBudget.Daily.SoftCostUSDMicros, snapshot.OrganizationBudget.Daily.SoftCostUSDMicros},
		{source.OrganizationBudget.Daily.HardCostUSDMicros, snapshot.OrganizationBudget.Daily.HardCostUSDMicros},
		{source.OrganizationBudget.Monthly.HardCostUSDMicros, snapshot.OrganizationBudget.Monthly.HardCostUSDMicros},
	} {
		require.NotSame(t, pair[0], pair[1], "the wire budget must not alias the stored caps")
	}
	*source.OrganizationBudget.Daily.HardCostUSDMicros = 42
	require.EqualValues(t, 60, *snapshot.OrganizationBudget.Daily.HardCostUSDMicros,
		"mutating the source caps must not change the projected wire budget")

	budgetJSON, err := json.Marshal(snapshot.OrganizationBudget)
	require.NoError(t, err)
	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(budgetJSON, &fields))
	require.Len(t, fields, 5)
	for _, field := range []string{"revision", "unknown_cost", "run_caps", "daily", "monthly"} {
		require.Contains(t, fields, field)
	}
	require.NotContains(t, fields, "organization_id", "the snapshot budget has no embedded organization")
	encoded, err := json.Marshal(snapshot)
	require.NoError(t, err)
	var envelope map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &envelope))
	require.JSONEq(t, `{"revision":3,"unknown_cost":"deny",
"run_caps":{"max_input_tokens":1000,"max_cost_usd_micros":50},
"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},
"monthly":{"hard_cost_usd_micros":900}}`, string(envelope["organization_budget"]))
}

func TestOrganizationBudgetProjectionRejectsInvalidStoredPolicy(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name   string
		mutate func(*domain.OrganizationBudget)
	}{
		{"soft-above-hard", func(budget *domain.OrganizationBudget) {
			budget.Daily.SoftCostUSDMicros, budget.Daily.HardCostUSDMicros = modelCallPolicyInt64(61), modelCallPolicyInt64(60)
		}},
		{"inverted-monthly", func(budget *domain.OrganizationBudget) {
			budget.Monthly = domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64(10), HardCostUSDMicros: modelCallPolicyInt64(9)}
		}},
		{"unsafe-revision", func(budget *domain.OrganizationBudget) { budget.Revision = domain.MaximumModelBudget + 1 }},
		{"negative-run-cap", func(budget *domain.OrganizationBudget) { budget.RunCaps.MaxInputTokens = modelCallPolicyInt64(-1) }},
		{"unsupported-unknown-cost", func(budget *domain.OrganizationBudget) { budget.UnknownCost = "warn" }},
		{"default-shaped-mismatch", func(budget *domain.OrganizationBudget) {
			budget.Revision, budget.UnknownCost = 0, "deny"
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			source := modelCallPolicyProjectionSource("org-1", 4)
			source.OrganizationBudget = modelCallPolicyProjectionBudget()
			scenario.mutate(source.OrganizationBudget)
			_, err := BuildExecutionSnapshot(t.Context(), source, nil)
			require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
		})
	}
}

func TestOrganizationBudgetSnapshotValidation(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name   string
		budget *domain.OrganizationBudget
		valid  bool
	}{
		{"legacy-absent", nil, true},
		{"persisted-complete", modelCallPolicyProjectionBudget(), true},
		{"invalid-inverted", &domain.OrganizationBudget{Revision: 1, UnknownCost: "allow",
			Daily: domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64(10), HardCostUSDMicros: modelCallPolicyInt64(9)}}, false},
		{"invalid-unsafe-revision", &domain.OrganizationBudget{Revision: domain.MaximumModelBudget + 1, UnknownCost: "allow"}, false},
		{"invalid-unknown-cost", &domain.OrganizationBudget{Revision: 1, UnknownCost: "warn"}, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			snapshot := ports.ExecutionSnapshot{OrganizationID: "org-1", Revision: 4,
				OrganizationBudget: scenario.budget,
				Providers:          []ports.ExecutionProvider{}, Models: []ports.ExecutionModel{}, Agents: []ports.ExecutionAgent{}}
			err := snapshot.Validate()
			if scenario.valid {
				require.NoError(t, err)
			} else {
				require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
			}
		})
	}
}
