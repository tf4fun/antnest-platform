package application

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const modelCallPolicyMaxSafeRevision int64 = 9007199254740991

type modelCallPolicyContextKey struct{}

type modelCallPolicyApplicationStore struct {
	getResult   domain.ModelCallPolicy
	setResult   domain.ModelCallPolicy
	getErr      error
	setErr      error
	getCalls    []string
	setCalls    []ports.SetModelCallPolicy
	getContexts []context.Context
	setContexts []context.Context
}

var _ ports.ModelCallPolicyStore = (*modelCallPolicyApplicationStore)(nil)

func (store *modelCallPolicyApplicationStore) GetModelCallPolicy(ctx context.Context, organizationID string) (domain.ModelCallPolicy, error) {
	store.getCalls = append(store.getCalls, organizationID)
	store.getContexts = append(store.getContexts, ctx)
	return store.getResult, store.getErr
}

func (store *modelCallPolicyApplicationStore) SetModelCallPolicy(ctx context.Context, input ports.SetModelCallPolicy) (domain.ModelCallPolicy, error) {
	store.setCalls = append(store.setCalls, input)
	store.setContexts = append(store.setContexts, ctx)
	return store.setResult, store.setErr
}

func modelCallPolicyApplicationInput() SetModelCallPolicyInput {
	revision := int64(0)
	return SetModelCallPolicyInput{
		RequestID: "Request-1.a_b", OrganizationID: "Org-1.a_b", ActorPrincipalID: "Admin-1.a_b",
		ExpectedRevision: &revision, UnknownCost: "deny",
		RunCaps: &domain.RunBudget{MaxInputTokens: modelCallPolicyInt64(1000)},
		Daily:   &domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64(40), HardCostUSDMicros: modelCallPolicyInt64(60)},
		Monthly: &domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64(500)},
	}
}

func modelCallPolicyInt64(value int64) *int64 { return &value }

func modelCallPolicyExpectedMutation(input SetModelCallPolicyInput) ports.SetModelCallPolicy {
	return ports.SetModelCallPolicy{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID,
		ExpectedRevision: *input.ExpectedRevision, UnknownCost: input.UnknownCost,
		RunCaps: *input.RunCaps, Daily: *input.Daily, Monthly: *input.Monthly,
	}
}

func modelCallPolicyExpectedResult(input SetModelCallPolicyInput) domain.ModelCallPolicy {
	return domain.ModelCallPolicy{OrganizationID: input.OrganizationID, OrganizationBudget: domain.OrganizationBudget{
		Revision: *input.ExpectedRevision + 1, UnknownCost: input.UnknownCost,
		RunCaps: *input.RunCaps, Daily: *input.Daily, Monthly: *input.Monthly,
	}}
}

func TestModelCallPolicyServiceGetAcceptsOnlyScopedPolicySnapshots(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name   string
		policy domain.ModelCallPolicy
	}{
		{"historical-default", domain.DefaultModelCallPolicy("Org-1.a_b")},
		{"persisted-allow", domain.ModelCallPolicy{OrganizationID: "Org-1.a_b",
			OrganizationBudget: domain.OrganizationBudget{Revision: 1, UnknownCost: "allow"}}},
		{"persisted-deny-caps", domain.ModelCallPolicy{OrganizationID: "Org-1.a_b",
			OrganizationBudget: domain.OrganizationBudget{Revision: 7, UnknownCost: "deny",
				RunCaps: domain.RunBudget{MaxCostUSDMicros: modelCallPolicyInt64(9)},
				Daily:   domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64(1), HardCostUSDMicros: modelCallPolicyInt64(2)},
				Monthly: domain.PeriodCaps{HardCostUSDMicros: modelCallPolicyInt64(3)}}}},
		{"largest-safe-revision", domain.ModelCallPolicy{OrganizationID: "Org-1.a_b",
			OrganizationBudget: domain.OrganizationBudget{Revision: modelCallPolicyMaxSafeRevision, UnknownCost: "allow"}}},
		{"minimum-id", domain.ModelCallPolicy{OrganizationID: "A",
			OrganizationBudget: domain.OrganizationBudget{Revision: 1, UnknownCost: "allow"}}},
		{"maximum-id", domain.ModelCallPolicy{OrganizationID: strings.Repeat("A", 200),
			OrganizationBudget: domain.OrganizationBudget{Revision: 1, UnknownCost: "allow"}}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.WithValue(t.Context(), modelCallPolicyContextKey{}, "original-context")
			store := &modelCallPolicyApplicationStore{getResult: scenario.policy}
			result, err := NewModelCallPolicyService(store).Get(ctx, scenario.policy.OrganizationID)
			require.NoError(t, err)
			require.Equal(t, scenario.policy, result)
			require.Equal(t, []string{scenario.policy.OrganizationID}, store.getCalls)
			require.Empty(t, store.setCalls)
			require.Equal(t, ctx.Value(modelCallPolicyContextKey{}), store.getContexts[0].Value(modelCallPolicyContextKey{}))
		})
	}
}

func TestModelCallPolicyServiceGetRejectsInvalidScopeBeforeStorage(t *testing.T) {
	t.Parallel()
	for _, scenario := range runtimeBarrierPolicyInvalidIDs() {
		t.Run(scenario.name, func(t *testing.T) {
			store := &modelCallPolicyApplicationStore{}
			_, err := NewModelCallPolicyService(store).Get(t.Context(), scenario.value)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Empty(t, store.getCalls)
			require.Empty(t, store.setCalls)
		})
	}
}

func TestModelCallPolicyServiceSetPassesTheOriginalMutationToStorage(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name     string
		revision int64
		id       string
	}{
		{"first-policy", 0, "A"},
		{"persisted-maximum-id", 17, strings.Repeat("A", 200)},
		{"last-increment-within-safe-range", modelCallPolicyMaxSafeRevision - 1, "Last-Safe"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := modelCallPolicyApplicationInput()
			input.RequestID, input.OrganizationID, input.ActorPrincipalID = scenario.id, scenario.id, scenario.id
			input.ExpectedRevision = &scenario.revision
			before := input
			ctx := context.WithValue(t.Context(), modelCallPolicyContextKey{}, "original-context")
			store := &modelCallPolicyApplicationStore{setResult: modelCallPolicyExpectedResult(input)}
			result, err := NewModelCallPolicyService(store).Set(ctx, input)
			require.NoError(t, err)
			require.Equal(t, store.setResult, result)
			require.Equal(t, []ports.SetModelCallPolicy{modelCallPolicyExpectedMutation(input)}, store.setCalls)
			require.Empty(t, store.getCalls, "the application must delegate atomic CAS instead of reading before writing")
			require.Equal(t, before, input)
			require.Equal(t, ctx.Value(modelCallPolicyContextKey{}), store.setContexts[0].Value(modelCallPolicyContextKey{}))
		})
	}
}

func TestModelCallPolicyServiceSetDoesNotAliasInputCaps(t *testing.T) {
	t.Parallel()
	input := modelCallPolicyApplicationInput()
	store := &modelCallPolicyApplicationStore{setResult: modelCallPolicyExpectedResult(input)}
	_, err := NewModelCallPolicyService(store).Set(t.Context(), input)
	require.NoError(t, err)
	require.Len(t, store.setCalls, 1)
	mutation := store.setCalls[0]
	for _, pair := range [][2]*int64{
		{input.RunCaps.MaxInputTokens, mutation.RunCaps.MaxInputTokens},
		{input.Daily.SoftCostUSDMicros, mutation.Daily.SoftCostUSDMicros},
		{input.Daily.HardCostUSDMicros, mutation.Daily.HardCostUSDMicros},
		{input.Monthly.SoftCostUSDMicros, mutation.Monthly.SoftCostUSDMicros},
	} {
		require.NotSame(t, pair[0], pair[1])
	}
	*input.Daily.HardCostUSDMicros = 42
	require.NotEqual(t, *input.Daily.HardCostUSDMicros, *mutation.Daily.HardCostUSDMicros)
}

func TestModelCallPolicyServiceSetRejectsInvalidIDsWithoutNormalization(t *testing.T) {
	t.Parallel()
	for _, field := range []struct {
		name string
		set  func(*SetModelCallPolicyInput, string)
	}{
		{"request", func(input *SetModelCallPolicyInput, value string) { input.RequestID = value }},
		{"organization", func(input *SetModelCallPolicyInput, value string) { input.OrganizationID = value }},
		{"actor", func(input *SetModelCallPolicyInput, value string) { input.ActorPrincipalID = value }},
	} {
		for _, scenario := range runtimeBarrierPolicyInvalidIDs() {
			t.Run(field.name+"/"+scenario.name, func(t *testing.T) {
				input := modelCallPolicyApplicationInput()
				field.set(&input, scenario.value)
				store := &modelCallPolicyApplicationStore{}
				_, err := NewModelCallPolicyService(store).Set(t.Context(), input)
				require.ErrorIs(t, err, ErrInvalidInput)
				require.Empty(t, store.getCalls)
				require.Empty(t, store.setCalls)
			})
		}
	}
}

func TestModelCallPolicyServiceSetRejectsInvalidPolicyInputsBeforeStorage(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name string
		edit func(*SetModelCallPolicyInput)
	}{
		{"missing-expected-revision", func(input *SetModelCallPolicyInput) { input.ExpectedRevision = nil }},
		{"negative-expected-revision", func(input *SetModelCallPolicyInput) {
			input.ExpectedRevision = modelCallPolicyInt64(-1)
		}},
		{"unsafe-expected-revision", func(input *SetModelCallPolicyInput) {
			input.ExpectedRevision = modelCallPolicyInt64(modelCallPolicyMaxSafeRevision + 1)
		}},
		{"missing-run-caps", func(input *SetModelCallPolicyInput) { input.RunCaps = nil }},
		{"missing-daily", func(input *SetModelCallPolicyInput) { input.Daily = nil }},
		{"missing-monthly", func(input *SetModelCallPolicyInput) { input.Monthly = nil }},
		{"missing-unknown-cost", func(input *SetModelCallPolicyInput) { input.UnknownCost = "" }},
		{"uppercase-unknown-cost", func(input *SetModelCallPolicyInput) { input.UnknownCost = "DENY" }},
		{"unsupported-unknown-cost", func(input *SetModelCallPolicyInput) { input.UnknownCost = "warn" }},
		{"negative-run-cap", func(input *SetModelCallPolicyInput) {
			input.RunCaps.MaxCostUSDMicros = modelCallPolicyInt64(-1)
		}},
		{"unsafe-run-cap", func(input *SetModelCallPolicyInput) {
			input.RunCaps.MaxInputTokens = modelCallPolicyInt64(modelCallPolicyMaxSafeRevision + 1)
		}},
		{"daily-soft-above-hard", func(input *SetModelCallPolicyInput) {
			input.Daily.SoftCostUSDMicros, input.Daily.HardCostUSDMicros = modelCallPolicyInt64(61), modelCallPolicyInt64(60)
		}},
		{"monthly-soft-above-hard", func(input *SetModelCallPolicyInput) {
			input.Monthly.SoftCostUSDMicros, input.Monthly.HardCostUSDMicros = modelCallPolicyInt64(61), modelCallPolicyInt64(60)
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := modelCallPolicyApplicationInput()
			scenario.edit(&input)
			store := &modelCallPolicyApplicationStore{}
			_, err := NewModelCallPolicyService(store).Set(t.Context(), input)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Empty(t, store.getCalls)
			require.Empty(t, store.setCalls)
		})
	}
}

func TestModelCallPolicyServicePreservesStoreErrorsWithoutFallbackOrRetry(t *testing.T) {
	t.Parallel()
	unavailable := errors.New("policy store unavailable")
	for _, scenario := range []struct {
		name string
		err  error
	}{
		{"dependency", unavailable},
		{"not-found", ports.ErrNotFound},
		{"concurrent-change", ports.ErrConcurrentChange},
		{"request-conflict", ports.ErrRequestConflict},
		{"cancelled", context.Canceled},
		{"deadline", context.DeadlineExceeded},
	} {
		for _, operation := range []string{"get", "set"} {
			t.Run(operation+"/"+scenario.name, func(t *testing.T) {
				input := modelCallPolicyApplicationInput()
				failure := fmt.Errorf("injected repository failure: %w", scenario.err)
				store := &modelCallPolicyApplicationStore{
					getResult: domain.DefaultModelCallPolicy(input.OrganizationID),
					setResult: modelCallPolicyExpectedResult(input), getErr: failure, setErr: failure,
				}
				service := NewModelCallPolicyService(store)
				var err error
				if operation == "get" {
					_, err = service.Get(t.Context(), input.OrganizationID)
					require.Equal(t, []string{input.OrganizationID}, store.getCalls)
					require.Empty(t, store.setCalls)
				} else {
					_, err = service.Set(t.Context(), input)
					require.Equal(t, []ports.SetModelCallPolicy{modelCallPolicyExpectedMutation(input)}, store.setCalls)
					require.Empty(t, store.getCalls)
				}
				require.ErrorIs(t, err, scenario.err)
				require.ErrorIs(t, err, failure, "the original repository error must remain in the chain")
			})
		}
	}
}

func TestModelCallPolicyServiceRejectsMalformedStoreSnapshots(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name string
		edit func(*domain.ModelCallPolicy)
	}{
		{"foreign-organization", func(policy *domain.ModelCallPolicy) { policy.OrganizationID = "Other-Org" }},
		{"missing-organization", func(policy *domain.ModelCallPolicy) { policy.OrganizationID = "" }},
		{"negative-revision", func(policy *domain.ModelCallPolicy) { policy.Revision = -1 }},
		{"unsafe-revision", func(policy *domain.ModelCallPolicy) { policy.Revision = modelCallPolicyMaxSafeRevision + 1 }},
		{"missing-unknown-cost", func(policy *domain.ModelCallPolicy) { policy.UnknownCost = "" }},
		{"unsupported-unknown-cost", func(policy *domain.ModelCallPolicy) { policy.UnknownCost = "warn" }},
		{"negative-cap", func(policy *domain.ModelCallPolicy) { policy.Daily.HardCostUSDMicros = modelCallPolicyInt64(-1) }},
		{"inverted-period", func(policy *domain.ModelCallPolicy) {
			policy.Monthly.SoftCostUSDMicros, policy.Monthly.HardCostUSDMicros = modelCallPolicyInt64(10), modelCallPolicyInt64(9)
		}},
	} {
		for _, operation := range []string{"get", "set"} {
			t.Run(operation+"/"+scenario.name, func(t *testing.T) {
				input := modelCallPolicyApplicationInput()
				result := modelCallPolicyExpectedResult(input)
				scenario.edit(&result)
				store := &modelCallPolicyApplicationStore{getResult: result, setResult: result}
				service := NewModelCallPolicyService(store)
				var err error
				if operation == "get" {
					_, err = service.Get(t.Context(), input.OrganizationID)
					require.Equal(t, []string{input.OrganizationID}, store.getCalls)
					require.Empty(t, store.setCalls)
				} else {
					_, err = service.Set(t.Context(), input)
					require.Equal(t, []ports.SetModelCallPolicy{modelCallPolicyExpectedMutation(input)}, store.setCalls)
					require.Empty(t, store.getCalls)
				}
				require.ErrorIs(t, err, ErrQueryContract)
			})
		}
	}
}

func TestModelCallPolicyServiceSetRequiresTheOriginalMutationResult(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name string
		edit func(*domain.ModelCallPolicy)
	}{
		{"old-revision", func(policy *domain.ModelCallPolicy) { policy.Revision = 5 }},
		{"skipped-revision", func(policy *domain.ModelCallPolicy) { policy.Revision = 7 }},
		{"another-valid-unknown-cost", func(policy *domain.ModelCallPolicy) { policy.UnknownCost = "allow" }},
		{"dropped-run-cap", func(policy *domain.ModelCallPolicy) { policy.RunCaps.MaxInputTokens = nil }},
		{"changed-daily-cap", func(policy *domain.ModelCallPolicy) { policy.Daily.HardCostUSDMicros = modelCallPolicyInt64(61) }},
		{"added-monthly-cap", func(policy *domain.ModelCallPolicy) { policy.Monthly.HardCostUSDMicros = modelCallPolicyInt64(501) }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := modelCallPolicyApplicationInput()
			revision := int64(5)
			input.ExpectedRevision = &revision
			result := modelCallPolicyExpectedResult(input)
			scenario.edit(&result)
			store := &modelCallPolicyApplicationStore{setResult: result}
			_, err := NewModelCallPolicyService(store).Set(t.Context(), input)
			require.ErrorIs(t, err, ErrQueryContract)
			require.Equal(t, []ports.SetModelCallPolicy{modelCallPolicyExpectedMutation(input)}, store.setCalls)
			require.Empty(t, store.getCalls)
		})
	}
}

func TestModelCallPolicyServiceNilStoreReturnsErrorsWithoutPanicking(t *testing.T) {
	t.Parallel()
	service := NewModelCallPolicyService(nil)
	_, err := service.Get(t.Context(), "Org-1.a_b")
	require.Error(t, err)
	_, err = service.Set(t.Context(), modelCallPolicyApplicationInput())
	require.Error(t, err)
}
