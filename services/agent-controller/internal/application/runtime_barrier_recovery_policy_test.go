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

const runtimeBarrierPolicyMaxSafeRevision int64 = 9007199254740991

type runtimeBarrierPolicyContextKey struct{}

// This stub records application calls and returns prescribed repository results.
// It does not implement CAS, persist receipts, or simulate transaction replay.
type runtimeBarrierPolicyApplicationStore struct {
	getResult   domain.RuntimeBarrierRecoveryPolicy
	setResult   domain.RuntimeBarrierRecoveryPolicy
	getErr      error
	setErr      error
	getCalls    []string
	setCalls    []ports.SetRuntimeBarrierRecoveryPolicy
	getContexts []context.Context
	setContexts []context.Context
}

var _ ports.RuntimeBarrierRecoveryPolicyStore = (*runtimeBarrierPolicyApplicationStore)(nil)

func (store *runtimeBarrierPolicyApplicationStore) GetRuntimeBarrierRecoveryPolicy(ctx context.Context, organizationID string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	store.getCalls = append(store.getCalls, organizationID)
	store.getContexts = append(store.getContexts, ctx)
	return store.getResult, store.getErr
}

func (store *runtimeBarrierPolicyApplicationStore) SetRuntimeBarrierRecoveryPolicy(ctx context.Context, input ports.SetRuntimeBarrierRecoveryPolicy) (domain.RuntimeBarrierRecoveryPolicy, error) {
	store.setCalls = append(store.setCalls, input)
	store.setContexts = append(store.setContexts, ctx)
	return store.setResult, store.setErr
}

func runtimeBarrierPolicyApplicationInput() SetRuntimeBarrierRecoveryPolicyInput {
	revision := int64(0)
	return SetRuntimeBarrierRecoveryPolicyInput{
		RequestID: "Request-1.a_b", OrganizationID: "Org-1.a_b", ActorPrincipalID: "Admin-1.a_b",
		ExpectedRevision: &revision, Mode: "notify", CooldownMS: 300000,
	}
}

func runtimeBarrierPolicyExpectedMutation(input SetRuntimeBarrierRecoveryPolicyInput) ports.SetRuntimeBarrierRecoveryPolicy {
	return ports.SetRuntimeBarrierRecoveryPolicy{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID,
		ExpectedRevision: *input.ExpectedRevision, Mode: input.Mode, CooldownMS: input.CooldownMS,
	}
}

func runtimeBarrierPolicyExpectedResult(input SetRuntimeBarrierRecoveryPolicyInput) domain.RuntimeBarrierRecoveryPolicy {
	return domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: input.OrganizationID, Revision: *input.ExpectedRevision + 1,
		Mode: input.Mode, CooldownMS: input.CooldownMS,
	}
}

func runtimeBarrierPolicyInvalidIDs() []struct {
	name  string
	value string
} {
	return []struct {
		name  string
		value string
	}{
		{"missing", ""},
		{"too-long", strings.Repeat("a", 201)},
		{"leading-space", " id"},
		{"trailing-space", "id "},
		{"embedded-space", "id value"},
		{"newline", "id\n"},
		{"tab", "id\tvalue"},
		{"slash", "id/value"},
		{"colon", "id:value"},
		{"non-ascii", "组织"},
		{"non-alphanumeric-start", "_id"},
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceGetAcceptsOnlyScopedPolicySnapshots(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name   string
		policy domain.RuntimeBarrierRecoveryPolicy
	}{
		{"historical-default", domain.RuntimeBarrierRecoveryPolicy{OrganizationID: "Org-1.a_b", Revision: 0, Mode: "manual", CooldownMS: 300000}},
		{"persisted-auto-minimum", domain.RuntimeBarrierRecoveryPolicy{OrganizationID: "Org-1.a_b", Revision: 1, Mode: "auto", CooldownMS: 60000}},
		{"persisted-notify-maximum", domain.RuntimeBarrierRecoveryPolicy{OrganizationID: "Org-1.a_b", Revision: 7, Mode: "notify", CooldownMS: 86400000}},
		{"persisted-manual", domain.RuntimeBarrierRecoveryPolicy{OrganizationID: "Org-1.a_b", Revision: 2, Mode: "manual", CooldownMS: 300000}},
		{"largest-safe-revision", domain.RuntimeBarrierRecoveryPolicy{OrganizationID: "Org-1.a_b", Revision: runtimeBarrierPolicyMaxSafeRevision, Mode: "auto", CooldownMS: 300000}},
		{"minimum-id", domain.RuntimeBarrierRecoveryPolicy{OrganizationID: "A", Revision: 1, Mode: "manual", CooldownMS: 300000}},
		{"maximum-id", domain.RuntimeBarrierRecoveryPolicy{OrganizationID: strings.Repeat("A", 200), Revision: 1, Mode: "manual", CooldownMS: 300000}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.WithValue(t.Context(), runtimeBarrierPolicyContextKey{}, "original-context")
			store := &runtimeBarrierPolicyApplicationStore{getResult: scenario.policy}
			result, err := NewRuntimeBarrierRecoveryPolicyService(store).Get(ctx, scenario.policy.OrganizationID)
			require.NoError(t, err)
			require.Equal(t, scenario.policy, result)
			require.Equal(t, []string{scenario.policy.OrganizationID}, store.getCalls)
			require.Empty(t, store.setCalls)
			require.Equal(t, ctx.Value(runtimeBarrierPolicyContextKey{}), store.getContexts[0].Value(runtimeBarrierPolicyContextKey{}))
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceGetRejectsInvalidScopeBeforeStorage(t *testing.T) {
	t.Parallel()
	for _, scenario := range runtimeBarrierPolicyInvalidIDs() {
		t.Run(scenario.name, func(t *testing.T) {
			store := &runtimeBarrierPolicyApplicationStore{}
			_, err := NewRuntimeBarrierRecoveryPolicyService(store).Get(t.Context(), scenario.value)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Empty(t, store.getCalls)
			require.Empty(t, store.setCalls)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceSetPassesTheOriginalMutationToStorage(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name     string
		mode     string
		cooldown int64
		revision int64
		id       string
	}{
		{"first-auto-minimum", "auto", 60000, 0, "A"},
		{"persisted-notify-maximum", "notify", 86400000, 17, "Mixed-Case.ID_1"},
		{"manual-default-cooldown", "manual", 300000, 3, "Request-1.a_b"},
		{"maximum-identities", "notify", 300000, 1, strings.Repeat("A", 200)},
		{"last-increment-within-safe-range", "auto", 300000, runtimeBarrierPolicyMaxSafeRevision - 1, "Last-Safe"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := runtimeBarrierPolicyApplicationInput()
			input.RequestID, input.OrganizationID, input.ActorPrincipalID = scenario.id, scenario.id, scenario.id
			input.ExpectedRevision = &scenario.revision
			input.Mode, input.CooldownMS = scenario.mode, scenario.cooldown
			before := input
			expectedRevision := *input.ExpectedRevision
			ctx := context.WithValue(t.Context(), runtimeBarrierPolicyContextKey{}, "original-context")
			store := &runtimeBarrierPolicyApplicationStore{setResult: runtimeBarrierPolicyExpectedResult(input)}
			result, err := NewRuntimeBarrierRecoveryPolicyService(store).Set(ctx, input)
			require.NoError(t, err)
			require.Equal(t, store.setResult, result)
			require.Equal(t, []ports.SetRuntimeBarrierRecoveryPolicy{runtimeBarrierPolicyExpectedMutation(input)}, store.setCalls)
			require.Empty(t, store.getCalls, "the application must delegate atomic CAS instead of reading before writing")
			require.Equal(t, before, input)
			require.Equal(t, expectedRevision, *input.ExpectedRevision, "the caller's expected revision must not be modified")
			require.Equal(t, ctx.Value(runtimeBarrierPolicyContextKey{}), store.setContexts[0].Value(runtimeBarrierPolicyContextKey{}))
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceSetRejectsInvalidIDsWithoutNormalization(t *testing.T) {
	t.Parallel()
	for _, field := range []struct {
		name string
		set  func(*SetRuntimeBarrierRecoveryPolicyInput, string)
	}{
		{"request", func(input *SetRuntimeBarrierRecoveryPolicyInput, value string) { input.RequestID = value }},
		{"organization", func(input *SetRuntimeBarrierRecoveryPolicyInput, value string) { input.OrganizationID = value }},
		{"actor", func(input *SetRuntimeBarrierRecoveryPolicyInput, value string) { input.ActorPrincipalID = value }},
	} {
		for _, scenario := range runtimeBarrierPolicyInvalidIDs() {
			t.Run(field.name+"/"+scenario.name, func(t *testing.T) {
				input := runtimeBarrierPolicyApplicationInput()
				field.set(&input, scenario.value)
				store := &runtimeBarrierPolicyApplicationStore{}
				_, err := NewRuntimeBarrierRecoveryPolicyService(store).Set(t.Context(), input)
				require.ErrorIs(t, err, ErrInvalidInput)
				require.Empty(t, store.getCalls)
				require.Empty(t, store.setCalls)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceSetRejectsInvalidPolicyInputsBeforeStorage(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name string
		edit func(*SetRuntimeBarrierRecoveryPolicyInput)
	}{
		{"missing-expected-revision", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.ExpectedRevision = nil }},
		{"negative-expected-revision", func(input *SetRuntimeBarrierRecoveryPolicyInput) {
			revision := int64(-1)
			input.ExpectedRevision = &revision
		}},
		{"unsafe-expected-revision", func(input *SetRuntimeBarrierRecoveryPolicyInput) {
			revision := runtimeBarrierPolicyMaxSafeRevision + 1
			input.ExpectedRevision = &revision
		}},
		{"int64-maximum-revision", func(input *SetRuntimeBarrierRecoveryPolicyInput) {
			revision := int64(9223372036854775807)
			input.ExpectedRevision = &revision
		}},
		{"missing-mode", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.Mode = "" }},
		{"uppercase-mode", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.Mode = "AUTO" }},
		{"padded-mode", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.Mode = " manual " }},
		{"unsupported-mode", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.Mode = "automatic" }},
		{"negative-cooldown", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.CooldownMS = -1 }},
		{"zero-cooldown", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.CooldownMS = 0 }},
		{"short-cooldown", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.CooldownMS = 59999 }},
		{"long-cooldown", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.CooldownMS = 86400001 }},
		{"int64-maximum-cooldown", func(input *SetRuntimeBarrierRecoveryPolicyInput) { input.CooldownMS = 9223372036854775807 }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := runtimeBarrierPolicyApplicationInput()
			scenario.edit(&input)
			store := &runtimeBarrierPolicyApplicationStore{}
			_, err := NewRuntimeBarrierRecoveryPolicyService(store).Set(t.Context(), input)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Empty(t, store.getCalls)
			require.Empty(t, store.setCalls)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceDelegatesEveryRepeatedRequest(t *testing.T) {
	t.Parallel()
	input := runtimeBarrierPolicyApplicationInput()
	store := &runtimeBarrierPolicyApplicationStore{setResult: runtimeBarrierPolicyExpectedResult(input)}
	service := NewRuntimeBarrierRecoveryPolicyService(store)
	for range 2 {
		result, err := service.Set(t.Context(), input)
		require.NoError(t, err)
		require.Equal(t, store.setResult, result)
	}
	mutation := runtimeBarrierPolicyExpectedMutation(input)
	require.Equal(t, []ports.SetRuntimeBarrierRecoveryPolicy{mutation, mutation}, store.setCalls)
	require.Empty(t, store.getCalls)
}

func TestRuntimeBarrierRecoveryPolicyServicePreservesStoreErrorsWithoutFallbackOrRetry(t *testing.T) {
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
				input := runtimeBarrierPolicyApplicationInput()
				failure := fmt.Errorf("injected repository failure: %w", scenario.err)
				store := &runtimeBarrierPolicyApplicationStore{
					getResult: domain.RuntimeBarrierRecoveryPolicy{OrganizationID: input.OrganizationID, Revision: 0, Mode: "manual", CooldownMS: 300000},
					setResult: runtimeBarrierPolicyExpectedResult(input), getErr: failure, setErr: failure,
				}
				service := NewRuntimeBarrierRecoveryPolicyService(store)
				var err error
				if operation == "get" {
					_, err = service.Get(t.Context(), input.OrganizationID)
					require.Equal(t, []string{input.OrganizationID}, store.getCalls)
					require.Empty(t, store.setCalls)
				} else {
					_, err = service.Set(t.Context(), input)
					require.Equal(t, []ports.SetRuntimeBarrierRecoveryPolicy{runtimeBarrierPolicyExpectedMutation(input)}, store.setCalls)
					require.Empty(t, store.getCalls)
				}
				require.ErrorIs(t, err, scenario.err)
				require.ErrorIs(t, err, failure, "the original repository error must remain in the chain")
			})
		}
	}
}

func runtimeBarrierPolicyInvalidResults() []struct {
	name string
	edit func(*domain.RuntimeBarrierRecoveryPolicy)
} {
	return []struct {
		name string
		edit func(*domain.RuntimeBarrierRecoveryPolicy)
	}{
		{"foreign-organization", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.OrganizationID = "Other-Org" }},
		{"missing-organization", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.OrganizationID = "" }},
		{"negative-revision", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Revision = -1 }},
		{"unsafe-revision", func(policy *domain.RuntimeBarrierRecoveryPolicy) {
			policy.Revision = runtimeBarrierPolicyMaxSafeRevision + 1
		}},
		{"missing-mode", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Mode = "" }},
		{"unknown-mode", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Mode = "automatic" }},
		{"uppercase-mode", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Mode = "AUTO" }},
		{"padded-mode", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Mode = " manual " }},
		{"negative-cooldown", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.CooldownMS = -1 }},
		{"zero-cooldown", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.CooldownMS = 0 }},
		{"short-cooldown", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.CooldownMS = 59999 }},
		{"long-cooldown", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.CooldownMS = 86400001 }},
		{"false-auto-default", func(policy *domain.RuntimeBarrierRecoveryPolicy) {
			policy.Revision, policy.Mode, policy.CooldownMS = 0, "auto", 300000
		}},
		{"false-notify-default", func(policy *domain.RuntimeBarrierRecoveryPolicy) {
			policy.Revision, policy.Mode, policy.CooldownMS = 0, "notify", 300000
		}},
		{"false-cooldown-default", func(policy *domain.RuntimeBarrierRecoveryPolicy) {
			policy.Revision, policy.Mode, policy.CooldownMS = 0, "manual", 60000
		}},
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceRejectsMalformedStoreSnapshots(t *testing.T) {
	t.Parallel()
	for _, scenario := range runtimeBarrierPolicyInvalidResults() {
		for _, operation := range []string{"get", "set"} {
			t.Run(operation+"/"+scenario.name, func(t *testing.T) {
				input := runtimeBarrierPolicyApplicationInput()
				result := runtimeBarrierPolicyExpectedResult(input)
				scenario.edit(&result)
				store := &runtimeBarrierPolicyApplicationStore{getResult: result, setResult: result}
				service := NewRuntimeBarrierRecoveryPolicyService(store)
				var err error
				if operation == "get" {
					_, err = service.Get(t.Context(), input.OrganizationID)
					require.Equal(t, []string{input.OrganizationID}, store.getCalls)
					require.Empty(t, store.setCalls)
				} else {
					_, err = service.Set(t.Context(), input)
					require.Equal(t, []ports.SetRuntimeBarrierRecoveryPolicy{runtimeBarrierPolicyExpectedMutation(input)}, store.setCalls)
					require.Empty(t, store.getCalls)
				}
				require.ErrorIs(t, err, ErrQueryContract)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceSetRequiresTheOriginalMutationResult(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name string
		edit func(*domain.RuntimeBarrierRecoveryPolicy)
	}{
		{"old-revision", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Revision = 5 }},
		{"skipped-revision", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Revision = 7 }},
		{"another-valid-mode", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.Mode = "auto" }},
		{"another-valid-cooldown", func(policy *domain.RuntimeBarrierRecoveryPolicy) { policy.CooldownMS = 60000 }},
		{"historical-default", func(policy *domain.RuntimeBarrierRecoveryPolicy) {
			policy.Revision, policy.Mode, policy.CooldownMS = 0, "manual", 300000
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := runtimeBarrierPolicyApplicationInput()
			revision := int64(5)
			input.ExpectedRevision = &revision
			result := runtimeBarrierPolicyExpectedResult(input)
			scenario.edit(&result)
			store := &runtimeBarrierPolicyApplicationStore{setResult: result}
			_, err := NewRuntimeBarrierRecoveryPolicyService(store).Set(t.Context(), input)
			require.ErrorIs(t, err, ErrQueryContract)
			require.Equal(t, []ports.SetRuntimeBarrierRecoveryPolicy{runtimeBarrierPolicyExpectedMutation(input)}, store.setCalls)
			require.Empty(t, store.getCalls)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceMaximumSafeExpectedRevisionRemainsAValidStoreRequest(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name     string
		revision int64
		storeErr error
		wantErr  error
	}{
		{"store-rejects-exhausted-revision", runtimeBarrierPolicyMaxSafeRevision, ports.ErrConcurrentChange, ports.ErrConcurrentChange},
		{"successful-unchanged-revision-is-invalid", runtimeBarrierPolicyMaxSafeRevision, nil, ErrQueryContract},
		{"successful-unsafe-increment-is-invalid", runtimeBarrierPolicyMaxSafeRevision + 1, nil, ErrQueryContract},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := runtimeBarrierPolicyApplicationInput()
			expected := runtimeBarrierPolicyMaxSafeRevision
			input.ExpectedRevision = &expected
			result := domain.RuntimeBarrierRecoveryPolicy{
				OrganizationID: input.OrganizationID, Revision: scenario.revision, Mode: input.Mode, CooldownMS: input.CooldownMS,
			}
			store := &runtimeBarrierPolicyApplicationStore{setResult: result, setErr: scenario.storeErr}
			_, err := NewRuntimeBarrierRecoveryPolicyService(store).Set(t.Context(), input)
			require.ErrorIs(t, err, scenario.wantErr)
			require.Equal(t, []ports.SetRuntimeBarrierRecoveryPolicy{runtimeBarrierPolicyExpectedMutation(input)}, store.setCalls)
			require.Empty(t, store.getCalls)
			require.Equal(t, runtimeBarrierPolicyMaxSafeRevision, expected)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyServiceNilStoreReturnsErrorsWithoutPanicking(t *testing.T) {
	t.Parallel()
	service := NewRuntimeBarrierRecoveryPolicyService(nil)
	_, err := service.Get(t.Context(), "Org-1.a_b")
	require.Error(t, err)
	_, err = service.Set(t.Context(), runtimeBarrierPolicyApplicationInput())
	require.Error(t, err)
}
