package domain

import (
	"testing"
	"time"
)

func retryBaseInput() NewLifecycleOperationInput {
	return NewLifecycleOperationInput{
		RequestID: "request-retry", RequestFingerprint: "fingerprint", AgentID: "agent-1",
		Kind: OperationRebuild, SourceSpecRevision: "spec-source",
		SourceRuntimeRevision: "runtime-1", TargetSpecRevision: "spec-target",
		Now: time.Now(),
	}
}

func TestOperationFailedCreateRetryMarkerValidation(t *testing.T) {
	if _, err := NewLifecycleOperation(retryBaseInput()); err != nil {
		t.Fatalf("normal rebuild must stay valid: %v", err)
	}
	marker := retryBaseInput()
	marker.SourceRuntimeRevision = ""
	marker.SourceFailedCreateRequestID = "request-create-failed"
	if _, err := NewLifecycleOperation(marker); err != nil {
		t.Fatalf("marker-only rebuild must be valid: %v", err)
	}
	cases := []struct {
		name   string
		mutate func(*NewLifecycleOperationInput)
	}{
		{"marker on create", func(in *NewLifecycleOperationInput) {
			*in = retryBaseInput()
			in.Kind = OperationCreate
			in.SourceSpecRevision, in.SourceRuntimeRevision = "", ""
			in.SourceFailedCreateRequestID = "request-create-failed"
		}},
		{"marker on delete", func(in *NewLifecycleOperationInput) {
			*in = retryBaseInput()
			in.Kind = OperationDelete
			in.SourceSpecRevision, in.TargetSpecRevision = "", ""
			in.SourceRuntimeRevision = "runtime-1"
			in.SourceFailedCreateRequestID = "request-create-failed"
		}},
		{"marker with source runtime", func(in *NewLifecycleOperationInput) {
			*in = retryBaseInput()
			in.SourceFailedCreateRequestID = "request-create-failed"
		}},
		{"marker with source execution", func(in *NewLifecycleOperationInput) {
			*in = retryBaseInput()
			in.SourceRuntimeRevision = ""
			in.SourceExecutionRevision = "exec-1"
			in.SourceFailedCreateRequestID = "request-create-failed"
		}},
		{"marker with absence claim", func(in *NewLifecycleOperationInput) {
			*in = retryBaseInput()
			in.SourceRuntimeRevision = ""
			in.SourceRuntimeAbsent = true
			in.SourceFailedCreateRequestID = "request-create-failed"
		}},
		{"marker without target spec", func(in *NewLifecycleOperationInput) {
			*in = retryBaseInput()
			in.SourceRuntimeRevision, in.TargetSpecRevision = "", ""
			in.SourceFailedCreateRequestID = "request-create-failed"
		}},
	}
	for _, tc := range cases {
		input := NewLifecycleOperationInput{}
		tc.mutate(&input)
		if _, err := NewLifecycleOperation(input); err == nil {
			t.Fatalf("%s must be rejected", tc.name)
		}
	}
}
