package ports

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func currentReadinessRecordForTest() AgentRecord {
	readyAt := time.Date(2026, 10, 23, 1, 2, 3, 0, time.UTC)
	return AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "owner-1",
		AccessRevision: "access-1", AgentSpecRevisionID: "spec-1", ExecutionRevisionID: "execution-1",
		LastSuccessfulExecutionRevisionID: "execution-1", RuntimeRevision: "runtime-1",
		RuntimeExecutionID: "runtime-process-1", RuntimeMCPEndpoint: "http://runtime-1:8080/mcp",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable,
		OwnerAuthorizationSequence: 17, IdentityRevocationSequence: 16,
		Readiness: &AgentReadinessEvidence{
			Access:                  AgentAccessRecord{AgentID: "agent-1", PrincipalID: "owner-1", AccessRevision: "access-1", Active: true},
			OwnerRevocationSequence: 16, CommittedRevision: 12, AppliedRevision: 11,
			Binding: &RuntimeReadinessProof{
				AgentID: "agent-1", OrganizationID: "org-1", AgentSpecRevisionID: "spec-1",
				ExecutionRevisionID: "execution-1", RuntimeRevision: "runtime-1", RuntimeExecutionID: "runtime-process-1",
				OwnerUserID: "owner-1", AccessRevision: "access-1", OwnerAuthorizationSequence: 17,
				ReadyAfterRevision: 10, AppliedRevision: 11, ReadyAt: &readyAt,
			},
		},
	}
}

func currentReadinessUnboundForTest(record *AgentRecord, state domain.RuntimeState) {
	record.ExecutionRevisionID = ""
	record.LastSuccessfulExecutionRevisionID = ""
	record.RuntimeExecutionID = ""
	record.RuntimeMCPEndpoint = ""
	record.RuntimeState = state
	record.Readiness.Binding = nil
}

func TestAgentRecordCurrentReadinessStates(t *testing.T) {
	tests := []struct {
		name             string
		apply            func(*AgentRecord)
		want             string
		preparingBinding bool
	}{
		{"legacy healthy has unknown readiness", func(r *AgentRecord) { r.Readiness = nil }, "", false},
		{"legacy closed still has unknown readiness", func(r *AgentRecord) {
			r.Readiness = nil
			r.DesiredState = domain.DesiredDisabled
		}, "", false},
		{"matching acknowledged binding", func(*AgentRecord) {}, "ready", false},
		{"reopened binding awaits its own publication", func(r *AgentRecord) {
			r.Readiness.Binding.ReopenAfterRevision = 12
		}, "preparing", false},
		{"covered reopen does not wait for unrelated organization changes", func(r *AgentRecord) {
			r.Readiness.Binding.ReopenAfterRevision = 11
		}, "ready", false},
		{"historical failed Rebuild does not close recovered binding", func(r *AgentRecord) {
			r.FailureStage, r.FailureCode = "runtime_update", "runtime_conflict"
		}, "ready", false},
		{"unbound historical failure retains configured pending source", func(r *AgentRecord) {
			currentReadinessUnboundForTest(r, domain.RuntimeWaiting)
			r.FailureStage, r.FailureCode = "runtime_update", "runtime_conflict"
		}, "preparing", false},
		{"lifecycle invariant failure overrides healthy historical proof", func(r *AgentRecord) {
			r.FailureCode = "lifecycle_invariant_failed"
		}, "unavailable", false},
		{"revocation watermarks equal authorization remain eligible", func(r *AgentRecord) {
			r.IdentityRevocationSequence = r.OwnerAuthorizationSequence
			r.Readiness.OwnerRevocationSequence = r.OwnerAuthorizationSequence
		}, "ready", false},
		{"zero owner watermarks with exact proof remain eligible", func(r *AgentRecord) {
			r.OwnerAuthorizationSequence = 0
			r.IdentityRevocationSequence = 0
			r.Readiness.OwnerRevocationSequence = 0
			r.Readiness.Binding.OwnerAuthorizationSequence = 0
		}, "ready", false},
		{"healthy binding without proof is preparing", func(r *AgentRecord) { r.Readiness.Binding = nil }, "preparing", false},
		{"healthy binding without ready acknowledgement is preparing", func(r *AgentRecord) {
			r.Readiness.Binding.ReadyAt = nil
		}, "preparing", false},
		{"unapplied binding is preparing", func(r *AgentRecord) {
			r.Readiness.Binding.ReadyAt = nil
			r.Readiness.Binding.AppliedRevision = 0
			r.Readiness.AppliedRevision = 0
		}, "preparing", false},
		{"acknowledgement below binding threshold is preparing", func(r *AgentRecord) {
			r.Readiness.Binding.ReadyAt = nil
			r.Readiness.Binding.AppliedRevision = 9
			r.Readiness.AppliedRevision = 9
		}, "preparing", false},
		{"unbound unknown Runtime is preparing", func(r *AgentRecord) {
			currentReadinessUnboundForTest(r, domain.RuntimeUnknown)
		}, "preparing", true},
		{"unbound waiting Runtime is preparing", func(r *AgentRecord) {
			currentReadinessUnboundForTest(r, domain.RuntimeWaiting)
		}, "preparing", true},
		{"unbound healthy Runtime is still preparing", func(r *AgentRecord) {
			currentReadinessUnboundForTest(r, domain.RuntimeAvailable)
		}, "preparing", true},
		{"desired disabled overrides old proof", func(r *AgentRecord) { r.DesiredState = domain.DesiredDisabled }, "unavailable", false},
		{"desired deleted overrides old proof", func(r *AgentRecord) { r.DesiredState = domain.DesiredDeleted }, "unavailable", false},
		{"inactive lifecycle overrides old proof", func(r *AgentRecord) { r.LifecycleState = domain.AgentNotCreated }, "unavailable", false},
		{"disabled activation overrides old proof", func(r *AgentRecord) { r.ActivationState = domain.ActivationDisabled }, "unavailable", false},
		{"active lifecycle operation overrides old proof", func(r *AgentRecord) { r.ActiveOperationRequestID = "rebuild-2" }, "unavailable", false},
		{"unhealthy Runtime overrides old proof", func(r *AgentRecord) { r.RuntimeState = domain.RuntimeUnhealthy }, "unavailable", false},
		{"exited Runtime overrides old proof", func(r *AgentRecord) { r.RuntimeState = domain.RuntimeExited }, "unavailable", false},
		{"absent Runtime overrides old proof", func(r *AgentRecord) { r.RuntimeState = domain.RuntimeAbsent }, "unavailable", false},
		{"missing owner overrides old proof", func(r *AgentRecord) { r.OwnerUserID = "" }, "unavailable", false},
		{"missing spec cannot use old proof", func(r *AgentRecord) { r.AgentSpecRevisionID = "" }, "unavailable", false},
		{"partial execution binding cannot use old proof", func(r *AgentRecord) { r.ExecutionRevisionID = "" }, "unavailable", false},
		{"partial process binding cannot use old proof", func(r *AgentRecord) { r.RuntimeExecutionID = "" }, "unavailable", false},
		{"missing executable endpoint cannot use old proof", func(r *AgentRecord) { r.RuntimeMCPEndpoint = "" }, "unavailable", false},
		{"access revoked overrides old proof", func(r *AgentRecord) { r.Readiness.Access.Active = false }, "unavailable", false},
		{"access belongs to another Agent", func(r *AgentRecord) { r.Readiness.Access.AgentID = "agent-2" }, "unavailable", false},
		{"access belongs to another principal", func(r *AgentRecord) { r.Readiness.Access.PrincipalID = "owner-2" }, "unavailable", false},
		{"access revision does not match", func(r *AgentRecord) { r.Readiness.Access.AccessRevision = "access-2" }, "unavailable", false},
		{"owner revocation is newer than authorization", func(r *AgentRecord) {
			r.Readiness.OwnerRevocationSequence = r.OwnerAuthorizationSequence + 1
		}, "unavailable", false},
		{"record identity revocation is newer than authorization", func(r *AgentRecord) {
			r.IdentityRevocationSequence = r.OwnerAuthorizationSequence + 1
		}, "unavailable", false},
		{"unbound Agent still requires active access", func(r *AgentRecord) {
			currentReadinessUnboundForTest(r, domain.RuntimeWaiting)
			r.Readiness.Access.Active = false
		}, "unavailable", true},
		{"unbound Agent still requires current owner authorization", func(r *AgentRecord) {
			currentReadinessUnboundForTest(r, domain.RuntimeWaiting)
			r.Readiness.OwnerRevocationSequence = r.OwnerAuthorizationSequence + 1
		}, "unavailable", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := currentReadinessRecordForTest()
			require.True(t, record.ExecutionReady(), "fixture has complete executable binding")
			test.apply(&record)
			if test.preparingBinding {
				require.True(t, record.RuntimePreparing(), "fixture is a legitimate binding wait")
			}
			require.Equal(t, test.want, record.CurrentReadiness())
		})
	}
}

func TestAgentRecordCurrentReadinessRejectsStaleProof(t *testing.T) {
	fields := []struct {
		name string
		set  func(*RuntimeReadinessProof, string)
	}{
		{"Agent", func(p *RuntimeReadinessProof, value string) { p.AgentID = value }},
		{"organization", func(p *RuntimeReadinessProof, value string) { p.OrganizationID = value }},
		{"spec", func(p *RuntimeReadinessProof, value string) { p.AgentSpecRevisionID = value }},
		{"execution", func(p *RuntimeReadinessProof, value string) { p.ExecutionRevisionID = value }},
		{"Runtime", func(p *RuntimeReadinessProof, value string) { p.RuntimeRevision = value }},
		{"process", func(p *RuntimeReadinessProof, value string) { p.RuntimeExecutionID = value }},
		{"owner", func(p *RuntimeReadinessProof, value string) { p.OwnerUserID = value }},
		{"access", func(p *RuntimeReadinessProof, value string) { p.AccessRevision = value }},
	}
	for _, field := range fields {
		for _, value := range []string{"", "different-identity"} {
			t.Run(field.name+"/"+value, func(t *testing.T) {
				record := currentReadinessRecordForTest()
				field.set(record.Readiness.Binding, value)
				// A damaged proof cannot establish ready. Its unavailable versus
				// preparing classification is not a new wire rule in this batch.
				require.Contains(t, []string{"preparing", "unavailable"}, record.CurrentReadiness())
			})
		}
	}
	for _, sequence := range []int64{0, 16, 18} {
		t.Run(time.Duration(sequence).String()+" owner proof sequence", func(t *testing.T) {
			record := currentReadinessRecordForTest()
			record.Readiness.Binding.OwnerAuthorizationSequence = sequence
			require.Contains(t, []string{"preparing", "unavailable"}, record.CurrentReadiness())
		})
	}
}

func TestAgentRecordCurrentReadinessRevisionCoverage(t *testing.T) {
	const safe = int64(9007199254740991)
	tests := []struct {
		name                                        string
		threshold, proofApplied, applied, committed int64
		ready                                       bool
	}{
		{"smallest covered threshold", 1, 1, 1, 1, true},
		{"organization has advanced beyond ready proof", 10, 10, 11, 12, true},
		{"positive safe upper boundary", safe, safe, safe, safe, true},
		{"zero threshold", 0, 11, 11, 12, false},
		{"negative threshold", -1, 11, 11, 12, false},
		{"zero proof watermark", 10, 0, 11, 12, false},
		{"negative proof watermark", 10, -1, 11, 12, false},
		{"zero applied watermark", 10, 11, 0, 12, false},
		{"negative applied watermark", 10, 11, -1, 12, false},
		{"zero committed watermark", 10, 11, 11, 0, false},
		{"negative committed watermark", 10, 11, 11, -1, false},
		{"all zero cannot claim ready", 0, 0, 0, 0, false},
		{"ordered negative values cannot claim ready", -4, -3, -2, -1, false},
		{"proof does not cover threshold", 11, 10, 11, 12, false},
		{"proof exceeds actual organization acknowledgement", 10, 12, 11, 12, false},
		{"acknowledgement exceeds committed organization revision", 10, 11, 13, 12, false},
		{"unsafe committed revision", 10, 11, 11, safe + 1, false},
		{"ordered unsafe revisions cannot claim ready", safe + 1, safe + 1, safe + 1, safe + 1, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := currentReadinessRecordForTest()
			record.Readiness.Binding.ReadyAfterRevision = test.threshold
			record.Readiness.Binding.AppliedRevision = test.proofApplied
			record.Readiness.AppliedRevision = test.applied
			record.Readiness.CommittedRevision = test.committed
			if test.ready {
				require.Equal(t, "ready", record.CurrentReadiness())
			} else {
				require.Contains(t, []string{"preparing", "unavailable"}, record.CurrentReadiness())
			}
		})
	}
}

func TestAgentRecordCurrentReadinessRecomputesCurrentFacts(t *testing.T) {
	changes := []struct {
		name  string
		apply func(*AgentRecord)
	}{
		{"Agent replaced", func(r *AgentRecord) { r.AgentID = "agent-2" }},
		{"organization changed", func(r *AgentRecord) { r.OrganizationID = "org-2" }},
		{"spec replaced", func(r *AgentRecord) { r.AgentSpecRevisionID = "spec-2" }},
		{"execution replaced", func(r *AgentRecord) { r.ExecutionRevisionID = "execution-2" }},
		{"Runtime replaced", func(r *AgentRecord) { r.RuntimeRevision = "runtime-2" }},
		{"Runtime process replaced", func(r *AgentRecord) { r.RuntimeExecutionID = "runtime-process-2" }},
		{"owner changed", func(r *AgentRecord) { r.OwnerUserID = "owner-2" }},
		{"access advanced", func(r *AgentRecord) { r.AccessRevision = "access-2" }},
		{"owner authorization advanced", func(r *AgentRecord) { r.OwnerAuthorizationSequence++ }},
		{"identity revoked", func(r *AgentRecord) { r.IdentityRevocationSequence = 18 }},
		{"owner revoked", func(r *AgentRecord) { r.Readiness.OwnerRevocationSequence = 18 }},
		{"access deactivated", func(r *AgentRecord) { r.Readiness.Access.Active = false }},
		{"Runtime exited", func(r *AgentRecord) { r.RuntimeState = domain.RuntimeExited }},
		{"new lifecycle operation", func(r *AgentRecord) { r.ActiveOperationRequestID = "rebuild-2" }},
		{"threshold changed beyond acknowledgement", func(r *AgentRecord) { r.Readiness.Binding.ReadyAfterRevision = 12 }},
		{"organization acknowledgement no longer covers proof", func(r *AgentRecord) { r.Readiness.AppliedRevision = 10 }},
		{"ready acknowledgement removed", func(r *AgentRecord) { r.Readiness.Binding.ReadyAt = nil }},
	}
	for _, change := range changes {
		t.Run(change.name, func(t *testing.T) {
			record := currentReadinessRecordForTest()
			before := currentReadinessRecordForTest()
			require.Equal(t, "ready", record.CurrentReadiness())
			require.Equal(t, before, record, "reading does not modify evidence")
			change.apply(&record)
			require.Contains(t, []string{"preparing", "unavailable"}, record.CurrentReadiness())
			// Reuse the same record variable after restoring current facts, so
			// neither a prior ready nor a prior unavailable result may be cached.
			record = currentReadinessRecordForTest()
			require.Equal(t, "ready", record.CurrentReadiness())
		})
	}
}
