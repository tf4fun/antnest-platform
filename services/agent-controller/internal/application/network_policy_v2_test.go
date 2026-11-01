package application

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type networkPolicyWriterStub struct {
	networkPolicyClientStub
	putErr  error
	echo    *ports.NetworkPolicyRevision
	putRef  ports.NetworkPolicyReference
	putSpec ports.NetworkPolicySpec
	puts    int
}

func (stub *networkPolicyWriterStub) PutPolicyRevision(_ context.Context, ref ports.NetworkPolicyReference, spec ports.NetworkPolicySpec) (ports.NetworkPolicyRevision, error) {
	stub.puts++
	stub.putRef = ref
	stub.putSpec = spec
	if stub.putErr != nil {
		return ports.NetworkPolicyRevision{}, stub.putErr
	}
	if err := stub.call("put"); err != nil {
		return ports.NetworkPolicyRevision{}, err
	}
	if stub.echo != nil {
		return *stub.echo, nil
	}
	stub.assignment.NetworkPolicyReference = ref
	return ports.NetworkPolicyRevision{NetworkPolicyReference: ref, Spec: spec, Digest: "sha256:" + strings.Repeat("b", 64)}, nil
}

func specWriteInput(spec ports.NetworkPolicySpec) SetAgentNetworkPolicyInput {
	return SetAgentNetworkPolicyInput{
		AgentID:          "agent-1",
		RequestID:        "request-1",
		OrganizationID:   "org-1",
		ActorPrincipalID: "admin-1",
		SetNetworkPolicy: ports.SetNetworkPolicy{ExpectedResourceVersion: 7},
		Spec:             &spec,
	}
}

var testV2SpecValue = ports.NetworkPolicySpec{
	SchemaVersion: 2,
	Default:       "deny",
	Rules: []ports.NetworkPolicyRule{
		{Action: "allow", Domains: []string{"api.github.com"}, Ports: []ports.NetworkPolicyPort{{From: 443, To: 443}}},
		{Action: "allow", CIDRs: []string{"10.20.0.15/32"}, Ports: []ports.NetworkPolicyPort{{From: 443, To: 443}}},
	},
}

func scopedAgent() *networkAgentLookup {
	return &networkAgentLookup{record: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1",
		LifecycleState: domain.AgentCreated, DesiredState: domain.DesiredDisabled,
	}}
}

func TestNetworkPolicySpecWritePublishesDerivedRevisionThenCAS(t *testing.T) {
	agent := scopedAgent()
	egress := &networkPolicyWriterStub{}
	egress.assignment = ports.NetworkPolicyAssignment{AgentID: "agent-1", ResourceVersion: 8}
	service := NewNetworkPolicyService(agent, egress)
	result, err := service.SetAgentNetworkPolicy(context.Background(), specWriteInput(testV2SpecValue))
	if err != nil {
		t.Fatal(err)
	}
	expected, err := testV2SpecValue.Reference("org-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if egress.puts != 1 || egress.putRef != expected || !egress.putSpec.Equal(testV2SpecValue) {
		t.Fatalf("publication=%+v %+v want %+v", egress.putRef, egress.putSpec, expected)
	}
	if len(egress.mutations) != 1 {
		t.Fatalf("assignments=%d", len(egress.mutations))
	}
	mutation := egress.mutations[0]
	if mutation.NetworkPolicyReference != expected || mutation.ExpectedResourceVersion != 7 {
		t.Fatalf("CAS=%+v", mutation)
	}
	if result.ResourceVersion != 8 || result.NetworkPolicyReference != expected {
		t.Fatalf("result=%+v", result)
	}
	if !reflect.DeepEqual(egress.calls, []string{"put", "set"}) {
		t.Fatalf("call order=%v", egress.calls)
	}
	second, err := service.SetAgentNetworkPolicy(context.Background(), specWriteInput(testV2SpecValue))
	if err != nil {
		t.Fatal(err)
	}
	if second.NetworkPolicyReference != result.NetworkPolicyReference {
		t.Fatal("identical intent derived different references")
	}
}

func TestNetworkPolicySpecWriteScopesBeforeAnyPublication(t *testing.T) {
	egress := &networkPolicyWriterStub{}
	service := NewNetworkPolicyService(scopedAgent(), egress)
	input := specWriteInput(testV2SpecValue)
	input.OrganizationID = "foreign"
	if _, err := service.SetAgentNetworkPolicy(context.Background(), input); !errors.Is(err, ErrAgentNotFound) {
		t.Fatalf("foreign scope=%v", err)
	}
	if egress.puts != 0 || len(egress.calls) != 0 {
		t.Fatalf("foreign scope published: %v", egress.calls)
	}
}

func TestNetworkPolicySpecWriteStopsAtFailedOrInvalidEcho(t *testing.T) {
	for name, stub := range map[string]*networkPolicyWriterStub{
		"put_failure": {putErr: &ports.DependencyError{Service: "runtime-egress", Code: "control_plane_unavailable"}},
		"echo_mismatch": {echo: &ports.NetworkPolicyRevision{
			NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "custom/other", Revision: 1},
			Spec:                   ports.NetworkPolicySpec{SchemaVersion: 1, Action: "deny_all"},
			Digest:                 "sha256:" + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		}},
	} {
		t.Run(name, func(t *testing.T) {
			service := NewNetworkPolicyService(scopedAgent(), stub)
			if _, err := service.SetAgentNetworkPolicy(context.Background(), specWriteInput(testV2SpecValue)); err == nil {
				t.Fatal("accepted failed/invalid publication")
			}
			if len(stub.mutations) != 0 {
				t.Fatalf("CAS issued after publication failure: %v", stub.mutations)
			}
		})
	}
}

func TestNetworkPolicySpecWriteCASFailureNeverRetries(t *testing.T) {
	egress := &networkPolicyWriterStub{}
	egress.failAt = "set"
	egress.err = &ports.DependencyError{Service: "runtime-egress", Code: "resource_version_conflict"}
	service := NewNetworkPolicyService(scopedAgent(), egress)
	if _, err := service.SetAgentNetworkPolicy(context.Background(), specWriteInput(testV2SpecValue)); err == nil {
		t.Fatal("CAS conflict swallowed")
	}
	if !reflect.DeepEqual(egress.calls, []string{"put", "set"}) || len(egress.mutations) != 1 {
		t.Fatalf("retried CAS: %v %d", egress.calls, len(egress.mutations))
	}
}

func TestNetworkPolicySpecWriteWithoutWriterIsUnavailable(t *testing.T) {
	service := NewNetworkPolicyService(scopedAgent(), &networkPolicyClientStub{})
	_, err := service.SetAgentNetworkPolicy(context.Background(), specWriteInput(testV2SpecValue))
	var failure *ports.DependencyError
	if !errors.As(err, &failure) || failure.Code != "control_plane_unavailable" {
		t.Fatalf("missing writer=%v", err)
	}
}
