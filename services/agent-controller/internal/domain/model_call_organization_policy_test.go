package domain

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDefaultModelCallPolicyIsLogicalRevisionZero(t *testing.T) {
	for _, organization := range []string{"org-1", "Org_1.-", "A"} {
		policy := DefaultModelCallPolicy(organization)
		require.Equal(t, ModelCallPolicy{OrganizationID: organization, OrganizationBudget: OrganizationBudget{
			Revision: 0, UnknownCost: "allow",
		}}, policy)
		require.NoError(t, policy.Validate())
		encoded, err := json.Marshal(policy)
		require.NoError(t, err)
		require.JSONEq(t, `{"organization_id":"`+organization+`","revision":0,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`, string(encoded))
	}
	require.Error(t, DefaultModelCallPolicy("bad/org").Validate())
}

func TestOrganizationBudgetValidateAcceptsConfiguredBounds(t *testing.T) {
	one, maximum := int64(0), int64(9007199254740991)
	for _, scenario := range []struct {
		name   string
		budget OrganizationBudget
	}{
		{"persisted-allow-empty", OrganizationBudget{Revision: 1, UnknownCost: "allow"}},
		{"persisted-deny-empty", OrganizationBudget{Revision: 2, UnknownCost: "deny"}},
		{"zero-caps", OrganizationBudget{Revision: 1, UnknownCost: "deny",
			RunCaps: RunBudget{MaxInputTokens: &one, MaxOutputTokens: &one, MaxCostUSDMicros: &one},
			Daily:   PeriodCaps{SoftCostUSDMicros: &one, HardCostUSDMicros: &one},
			Monthly: PeriodCaps{SoftCostUSDMicros: &one, HardCostUSDMicros: &one}}},
		{"maximum-safe-caps", OrganizationBudget{Revision: MaximumModelBudget, UnknownCost: "allow",
			RunCaps: RunBudget{MaxInputTokens: &maximum, MaxOutputTokens: &maximum, MaxCostUSDMicros: &maximum},
			Daily:   PeriodCaps{SoftCostUSDMicros: &maximum, HardCostUSDMicros: &maximum},
			Monthly: PeriodCaps{SoftCostUSDMicros: &maximum, HardCostUSDMicros: &maximum}}},
		{"soft-equals-hard", OrganizationBudget{Revision: 3, UnknownCost: "allow",
			Daily:   PeriodCaps{SoftCostUSDMicros: &maximum, HardCostUSDMicros: &maximum},
			Monthly: PeriodCaps{SoftCostUSDMicros: &maximum, HardCostUSDMicros: &maximum}}},
		{"soft-only", OrganizationBudget{Revision: 3, UnknownCost: "allow", Daily: PeriodCaps{SoftCostUSDMicros: &one}}},
		{"hard-only", OrganizationBudget{Revision: 3, UnknownCost: "allow", Monthly: PeriodCaps{HardCostUSDMicros: &one}}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			require.NoError(t, scenario.budget.Validate())
		})
	}
}

func TestOrganizationBudgetValidateRejectsInvalidBounds(t *testing.T) {
	negative, unsafe, soft, hard := int64(-1), int64(9007199254740992), int64(11), int64(10)
	for _, scenario := range []struct {
		name   string
		budget OrganizationBudget
	}{
		{"negative-revision", OrganizationBudget{Revision: -1, UnknownCost: "allow"}},
		{"unsafe-revision", OrganizationBudget{Revision: unsafe, UnknownCost: "allow"}},
		{"missing-unknown-cost", OrganizationBudget{Revision: 1}},
		{"uppercase-unknown-cost", OrganizationBudget{Revision: 1, UnknownCost: "ALLOW"}},
		{"padded-unknown-cost", OrganizationBudget{Revision: 1, UnknownCost: " allow"}},
		{"unknown-cost-value", OrganizationBudget{Revision: 1, UnknownCost: "warn"}},
		{"negative-run-cap", OrganizationBudget{Revision: 1, UnknownCost: "allow", RunCaps: RunBudget{MaxInputTokens: &negative}}},
		{"unsafe-run-cap", OrganizationBudget{Revision: 1, UnknownCost: "allow", RunCaps: RunBudget{MaxCostUSDMicros: &unsafe}}},
		{"negative-daily-soft", OrganizationBudget{Revision: 1, UnknownCost: "allow", Daily: PeriodCaps{SoftCostUSDMicros: &negative}}},
		{"unsafe-daily-hard", OrganizationBudget{Revision: 1, UnknownCost: "allow", Daily: PeriodCaps{HardCostUSDMicros: &unsafe}}},
		{"daily-soft-above-hard", OrganizationBudget{Revision: 1, UnknownCost: "allow", Daily: PeriodCaps{SoftCostUSDMicros: &soft, HardCostUSDMicros: &hard}}},
		{"negative-monthly-soft", OrganizationBudget{Revision: 1, UnknownCost: "allow", Monthly: PeriodCaps{SoftCostUSDMicros: &negative}}},
		{"unsafe-monthly-hard", OrganizationBudget{Revision: 1, UnknownCost: "allow", Monthly: PeriodCaps{HardCostUSDMicros: &unsafe}}},
		{"monthly-soft-above-hard", OrganizationBudget{Revision: 1, UnknownCost: "allow", Monthly: PeriodCaps{SoftCostUSDMicros: &soft, HardCostUSDMicros: &hard}}},
		{"false-default-deny", OrganizationBudget{Revision: 0, UnknownCost: "deny"}},
		{"false-default-caps", OrganizationBudget{Revision: 0, UnknownCost: "allow", Daily: PeriodCaps{HardCostUSDMicros: &hard}}},
		{"false-default-run-cap", OrganizationBudget{Revision: 0, UnknownCost: "allow", RunCaps: RunBudget{MaxInputTokens: &soft}}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			require.Error(t, scenario.budget.Validate())
		})
	}
}

func TestModelCallPolicyValidateRequiresOrganization(t *testing.T) {
	policy := ModelCallPolicy{OrganizationID: "org-1", OrganizationBudget: OrganizationBudget{Revision: 1, UnknownCost: "deny"}}
	require.NoError(t, policy.Validate())
	for _, organization := range []string{"", "org/1", " org-1", "org-1 ", "_org", "org\n1"} {
		policy.OrganizationID = organization
		require.Error(t, policy.Validate(), organization)
	}
}

func TestModelCallPolicyJSONDecodesFlattenedStrictShape(t *testing.T) {
	var policy ModelCallPolicy
	require.NoError(t, json.Unmarshal([]byte(`{"organization_id":"org-1","revision":4,"unknown_cost":"deny",
"run_caps":{"max_input_tokens":1000,"max_output_tokens":200,"max_cost_usd_micros":50},
"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},
"monthly":{"soft_cost_usd_micros":500,"hard_cost_usd_micros":900}}`), &policy))
	require.Equal(t, ModelCallPolicy{OrganizationID: "org-1", OrganizationBudget: OrganizationBudget{
		Revision: 4, UnknownCost: "deny",
		RunCaps: RunBudget{MaxInputTokens: int64Pointer(1000), MaxOutputTokens: int64Pointer(200), MaxCostUSDMicros: int64Pointer(50)},
		Daily:   PeriodCaps{SoftCostUSDMicros: int64Pointer(40), HardCostUSDMicros: int64Pointer(60)},
		Monthly: PeriodCaps{SoftCostUSDMicros: int64Pointer(500), HardCostUSDMicros: int64Pointer(900)},
	}}, policy)
	encoded, err := json.Marshal(policy)
	require.NoError(t, err)
	require.JSONEq(t, `{"organization_id":"org-1","revision":4,"unknown_cost":"deny",
"run_caps":{"max_input_tokens":1000,"max_output_tokens":200,"max_cost_usd_micros":50},
"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},
"monthly":{"soft_cost_usd_micros":500,"hard_cost_usd_micros":900}}`, string(encoded))
	var zero ModelCallPolicy
	require.NoError(t, json.Unmarshal([]byte(`{"organization_id":"org-1","revision":0,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`), &zero))
	require.Equal(t, DefaultModelCallPolicy("org-1"), zero)
}

func TestModelCallPolicyJSONRejectsMalformedWire(t *testing.T) {
	for _, raw := range []string{
		`null`, `{}`, `[]`, `"policy"`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{}}`,
		`{"organization_id":null,"revision":1,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":null,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":null,"run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":null,"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":null,"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{},"extra":1}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{},"Organization_ID":"org-2"}`,
		`{"organization_id":"org/1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":-1,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1.5,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":"1","unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":9007199254740992,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"max_input_tokens":null},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"max_input_tokens":-1},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"max_input_tokens":0.5},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"max_input_tokens":"10"},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"max_input_tokens":9007199254740992},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"MAX_INPUT_TOKENS":1},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"max_input_tokens":1,"extra":1},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{"soft_cost_usd_micros":null},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{"soft_cost_usd_micros":-1},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{"soft_cost_usd_micros":0.5},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{"soft_cost_usd_micros":9007199254740992},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{"soft_cost_usd_micros":10,"hard_cost_usd_micros":9},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{"soft_cost_usd_micros":10,"hard_cost_usd_micros":9}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{"Soft_Cost_USD_Micros":1},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{},"daily":{"soft_cost_usd_micros":1,"extra":1},"monthly":{}}`,
		`{"organization_id":"org-1","revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			var policy ModelCallPolicy
			require.Error(t, json.Unmarshal([]byte(raw), &policy))
		})
	}
}

func TestOrganizationBudgetCloneDoesNotAliasCaps(t *testing.T) {
	budget := &OrganizationBudget{Revision: 7, UnknownCost: "deny",
		RunCaps: RunBudget{MaxInputTokens: int64Pointer(1), MaxOutputTokens: int64Pointer(2), MaxCostUSDMicros: int64Pointer(3)},
		Daily:   PeriodCaps{SoftCostUSDMicros: int64Pointer(4), HardCostUSDMicros: int64Pointer(5)},
		Monthly: PeriodCaps{SoftCostUSDMicros: int64Pointer(6), HardCostUSDMicros: int64Pointer(7)}}
	var nilBudget *OrganizationBudget
	require.Nil(t, nilBudget.Clone())
	clone := budget.Clone()
	require.Equal(t, *budget, *clone)
	for _, pair := range [][2]*int64{
		{budget.RunCaps.MaxInputTokens, clone.RunCaps.MaxInputTokens},
		{budget.RunCaps.MaxOutputTokens, clone.RunCaps.MaxOutputTokens},
		{budget.RunCaps.MaxCostUSDMicros, clone.RunCaps.MaxCostUSDMicros},
		{budget.Daily.SoftCostUSDMicros, clone.Daily.SoftCostUSDMicros},
		{budget.Daily.HardCostUSDMicros, clone.Daily.HardCostUSDMicros},
		{budget.Monthly.SoftCostUSDMicros, clone.Monthly.SoftCostUSDMicros},
		{budget.Monthly.HardCostUSDMicros, clone.Monthly.HardCostUSDMicros},
	} {
		require.NotSame(t, pair[0], pair[1])
	}
	*clone.Daily.HardCostUSDMicros = 42
	require.Equal(t, int64(5), *budget.Daily.HardCostUSDMicros)
	var nilCaps *PeriodCaps
	require.Nil(t, nilCaps.Clone())
}

func int64Pointer(value int64) *int64 { return &value }
