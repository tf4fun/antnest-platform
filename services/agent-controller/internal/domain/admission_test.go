package domain

import (
	"testing"
	"time"
)

func TestUnresolvedReportRequiresQuiescentExecutorAndKeepsOccupancy(t *testing.T) {
	t.Parallel()

	admission, err := NewRunAdmission("admission-1", "agent-1", "runtime-1")
	if err != nil {
		t.Fatalf("create admission: %v", err)
	}
	report := TerminalReport{
		Class: TerminalUnresolved, ToolEffectState: ToolEffectUnknown,
		ErrorClass: "tool_outcome_unknown",
	}
	if err := admission.Finish(report, time.Unix(1, 0).UTC()); err != nil {
		t.Fatalf("finish unresolved admission: %v", err)
	}
	if admission.State() != AdmissionBlockedUnknownEffect {
		t.Fatalf("state = %s", admission.State())
	}
	if admission.Report() == nil || admission.Report().Class != TerminalUnresolved {
		t.Fatal("terminal report was not preserved")
	}
}

func TestBlockedAdmissionReleasesOnlyAfterBoundRuntimeIsAbsent(t *testing.T) {
	t.Parallel()

	admission, err := NewRunAdmission("admission-1", "agent-1", "runtime-1")
	if err != nil {
		t.Fatalf("create admission: %v", err)
	}
	report := TerminalReport{
		Class: TerminalUnresolved, ToolEffectState: ToolEffectUnknown,
		ErrorClass: "tool_outcome_unknown",
	}
	if err := admission.Finish(report, time.Unix(1, 0).UTC()); err != nil {
		t.Fatalf("finish admission: %v", err)
	}
	if err := admission.ReleaseAfterRuntimeAbsent("operation-1", "runtime-2", time.Unix(2, 0).UTC()); err == nil {
		t.Fatal("different Runtime revision released admission")
	}
	if err := admission.ReleaseAfterRuntimeAbsent("operation-1", "runtime-1", time.Unix(2, 0).UTC()); err != nil {
		t.Fatalf("release admission: %v", err)
	}
	if admission.State() != AdmissionReleased || admission.ReleasedByOperationRequestID() != "operation-1" {
		t.Fatalf("release evidence missing: %+v", admission)
	}
	if admission.Report() == nil || admission.Report().Class != TerminalUnresolved {
		t.Fatal("release rewrote terminal report")
	}
}

func TestSettledTerminalReportReleasesImmediately(t *testing.T) {
	t.Parallel()

	admission, err := NewRunAdmission("admission-1", "agent-1", "runtime-1")
	if err != nil {
		t.Fatalf("create admission: %v", err)
	}
	report := TerminalReport{
		Class: TerminalCompleted, ToolEffectState: ToolEffectSettled,
		StopReason: "end_turn",
	}
	if err := admission.Finish(report, time.Unix(1, 0).UTC()); err != nil {
		t.Fatalf("finish admission: %v", err)
	}
	if admission.State() != AdmissionReleased {
		t.Fatalf("state = %s", admission.State())
	}
}
