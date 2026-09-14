package application

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type networkAgentLookup struct {
	record ports.AgentRecord
	err    error
	calls  int
}

func (source *networkAgentLookup) GetAgent(context.Context, string) (ports.AgentRecord, error) {
	source.calls++
	return source.record, source.err
}

type networkPolicyClientStub struct {
	calls      []string
	mutations  []ports.SetNetworkPolicy
	assignment ports.NetworkPolicyAssignment
	revision   ports.NetworkPolicyRevision
	attachment ports.NetworkAttachment
	failAt     string
	err        error
}

func (client *networkPolicyClientStub) call(name string) error {
	client.calls = append(client.calls, name)
	if client.failAt == name {
		return client.err
	}
	return nil
}

func (client *networkPolicyClientStub) GetAgentPolicyAssignment(context.Context, string) (ports.NetworkPolicyAssignment, error) {
	return client.assignment, client.call("assignment")
}

func (client *networkPolicyClientStub) GetPolicyRevision(_ context.Context, ref ports.NetworkPolicyReference) (ports.NetworkPolicyRevision, error) {
	if ref != client.assignment.NetworkPolicyReference {
		return ports.NetworkPolicyRevision{}, errors.New("wrong revision read")
	}
	return client.revision, client.call("revision")
}

func (client *networkPolicyClientStub) GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return client.attachment, client.call("attachment")
}

func (client *networkPolicyClientStub) SetAgentPolicyAssignment(_ context.Context, _ string, mutation ports.SetNetworkPolicy) (ports.NetworkPolicyAssignment, error) {
	client.mutations = append(client.mutations, mutation)
	return client.assignment, client.call("set")
}

func networkPolicyFixture() (*networkAgentLookup, *networkPolicyClientStub) {
	ref := ports.NetworkPolicyReference{PolicyID: "called-allow", Revision: 2}
	return &networkAgentLookup{record: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationDisabled, RuntimeState: domain.RuntimeAbsent, DesiredState: domain.DesiredDisabled,
		AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-1", AggregateSequence: 7,
	}}, &networkPolicyClientStub{
		assignment: ports.NetworkPolicyAssignment{AgentID: "agent-1", NetworkPolicyReference: ref, ResourceVersion: 3},
		revision:   ports.NetworkPolicyRevision{NetworkPolicyReference: ref, Spec: ports.NetworkPolicySpec{SchemaVersion: 1, Action: "deny_all"}, Digest: "sha256:" + strings.Repeat("a", 64)},
		attachment: ports.NetworkAttachment{AgentID: "agent-1", State: ports.NetworkStateActive, AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 4},
	}
}

func TestNetworkPolicyScopePrecedesEveryEgressCall(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name   string
		org    string
		change func(*networkAgentLookup)
		want   error
	}{
		{"missing scope", "", func(*networkAgentLookup) {}, ErrInvalidInput},
		{"cross organization", "org-2", func(*networkAgentLookup) {}, ErrAgentNotFound},
		{"missing agent", "org-1", func(s *networkAgentLookup) { s.err = ports.ErrNotFound }, ErrAgentNotFound},
		{"deleting", "org-1", func(s *networkAgentLookup) { s.record.DesiredState = domain.DesiredDeleted }, ErrAgentNotFound},
		{"deleted", "org-1", func(s *networkAgentLookup) { s.record.LifecycleState = domain.AgentDeleted }, ErrAgentNotFound},
		{"deleted intent", "org-1", func(s *networkAgentLookup) { s.record.DesiredState = domain.DesiredDeleted }, ErrAgentNotFound},
		{"wrong record", "org-1", func(s *networkAgentLookup) { s.record.AgentID = "agent-other" }, ErrQueryContract},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			source, client := networkPolicyFixture()
			scenario.change(source)
			service := NewNetworkPolicyService(source, client)
			_, err := service.GetAgentNetworkPolicy(context.Background(), scenario.org, "agent-1")
			if !errors.Is(err, scenario.want) {
				t.Fatalf("read error=%v", err)
			}
			input := networkPolicyInput()
			input.OrganizationID = scenario.org
			_, err = service.SetAgentNetworkPolicy(context.Background(), input)
			if !errors.Is(err, scenario.want) {
				t.Fatalf("write error=%v", err)
			}
			if len(client.calls) != 0 {
				t.Fatalf("out-of-scope Egress calls=%v", client.calls)
			}
		})
	}
}

func networkPolicyInput() SetAgentNetworkPolicyInput {
	return SetAgentNetworkPolicyInput{AgentID: "agent-1", RequestID: "request-1", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		SetNetworkPolicy: ports.SetNetworkPolicy{NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "called-allow", Revision: 2}, ExpectedResourceVersion: 2}}
}

func TestNetworkPolicyReadsExactSpecAndSeparateAttachment(t *testing.T) {
	t.Parallel()
	source, client := networkPolicyFixture()
	original := source.record
	view, err := NewNetworkPolicyService(source, client).GetAgentNetworkPolicy(context.Background(), "org-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if view.AgentID != "agent-1" || view.Policy.NetworkPolicyRevision != client.revision || view.Policy.ResourceVersion != 3 ||
		view.Attachment.State != "closed" || view.Attachment.ResourceVersion != 4 {
		t.Fatalf("view=%+v", view)
	}
	if !reflect.DeepEqual(client.calls, []string{"assignment", "revision", "attachment"}) || !reflect.DeepEqual(source.record, original) {
		t.Fatalf("unexpected effects: %v / %+v", client.calls, source.record)
	}
}

func TestNetworkPolicyWriteIsOneCASWithoutLifecycleOrReadRepair(t *testing.T) {
	t.Parallel()
	source, client := networkPolicyFixture()
	original := source.record
	input := networkPolicyInput()
	service := NewNetworkPolicyService(source, client)
	for range 2 {
		result, err := service.SetAgentNetworkPolicy(context.Background(), input)
		if err != nil || result != client.assignment {
			t.Fatalf("result=%+v error=%v", result, err)
		}
	}
	if !reflect.DeepEqual(client.calls, []string{"set", "set"}) || len(client.mutations) != 2 ||
		client.mutations[0] != input.SetNetworkPolicy || client.mutations[1] != input.SetNetworkPolicy || !reflect.DeepEqual(source.record, original) {
		t.Fatalf("changed retry or lifecycle: calls=%v mutations=%+v", client.calls, client.mutations)
	}
}

func TestNetworkPolicyFailureNeverRetriesOrReadsBackAsSuccess(t *testing.T) {
	t.Parallel()
	for _, code := range []string{"resource_version_conflict", "cleanup_failed", "control_plane_unavailable", "invalid_response"} {
		t.Run(code, func(t *testing.T) {
			source, client := networkPolicyFixture()
			client.failAt = "set"
			client.err = &ports.DependencyError{Service: "runtime-egress", Code: code, Retryable: true}
			_, err := NewNetworkPolicyService(source, client).SetAgentNetworkPolicy(context.Background(), networkPolicyInput())
			if !errors.Is(err, client.err) || !reflect.DeepEqual(client.calls, []string{"set"}) {
				t.Fatalf("error=%v calls=%v", err, client.calls)
			}
		})
	}
}

func TestNetworkPolicyInvalidMutationHasNoDependencyCalls(t *testing.T) {
	t.Parallel()
	for _, mutate := range []func(*SetAgentNetworkPolicyInput){
		func(i *SetAgentNetworkPolicyInput) { i.RequestID = "" }, func(i *SetAgentNetworkPolicyInput) { i.ActorPrincipalID = "" },
		func(i *SetAgentNetworkPolicyInput) { i.AgentID = "../agent-1" }, func(i *SetAgentNetworkPolicyInput) { i.PolicyID = "has space" },
		func(i *SetAgentNetworkPolicyInput) { i.Revision = 0 }, func(i *SetAgentNetworkPolicyInput) { i.ExpectedResourceVersion = 0 },
	} {
		source, client := networkPolicyFixture()
		input := networkPolicyInput()
		mutate(&input)
		_, err := NewNetworkPolicyService(source, client).SetAgentNetworkPolicy(context.Background(), input)
		if !errors.Is(err, ErrInvalidInput) || source.calls != 0 || len(client.calls) != 0 {
			t.Fatalf("invalid input effects: %v/%d/%v", err, source.calls, client.calls)
		}
	}
}

func TestNetworkPolicyDependencyReadFailureStopsProjection(t *testing.T) {
	t.Parallel()
	for _, stage := range []string{"assignment", "revision", "attachment"} {
		t.Run(stage, func(t *testing.T) {
			source, client := networkPolicyFixture()
			client.failAt = stage
			client.err = errors.New("injected read failure")
			_, err := NewNetworkPolicyService(source, client).GetAgentNetworkPolicy(context.Background(), "org-1", "agent-1")
			if !errors.Is(err, client.err) || client.calls[len(client.calls)-1] != stage {
				t.Fatalf("error=%v calls=%v", err, client.calls)
			}
		})
	}
}
