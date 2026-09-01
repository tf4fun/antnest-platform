package domain

import (
	"strings"
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
		UnknownEffectSource: UnknownEffectRuntimeMCP,
		ErrorClass:          "tool_outcome_unknown",
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
		UnknownEffectSource: UnknownEffectRuntimeMCP,
		ErrorClass:          "tool_outcome_unknown",
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

func TestCompletedReportRejectsUnknownStopReason(t *testing.T) {
	t.Parallel()

	_, err := ValidateTerminalReport(TerminalReport{
		Class: TerminalCompleted, ToolEffectState: ToolEffectSettled,
		StopReason: "invented_stop_reason",
	})
	if err == nil {
		t.Fatal("completed report accepted an unknown stop reason")
	}
}

func TestTerminalReportBoundsErrorClassAndCancelledFacts(t *testing.T) {
	t.Parallel()

	testCases := []TerminalReport{
		{Class: TerminalCancelled, ToolEffectState: ToolEffectNone, ErrorClass: "run_cancelled"},
		{Class: TerminalCompleted, ToolEffectState: ToolEffectSettled, StopReason: "end_turn", UnknownEffectSource: UnknownEffectRuntimeMCP},
		{Class: TerminalUnresolved, ToolEffectState: ToolEffectUnknown, ErrorClass: "missing_source"},
		{Class: TerminalFailed, ToolEffectState: ToolEffectSettled, ErrorClass: "contains secret"},
		{Class: TerminalUnresolved, ToolEffectState: ToolEffectUnknown, UnknownEffectSource: UnknownEffectRuntimeMCP, ErrorClass: strings.Repeat("a", 65)},
	}
	for _, report := range testCases {
		if _, err := ValidateTerminalReport(report); err == nil {
			t.Fatalf("accepted invalid terminal report %+v", report)
		}
	}
}

func TestTerminalReplayAllowsRuntimeBarrierRelease(t *testing.T) {
	t.Parallel()

	report := TerminalReport{
		Class: TerminalUnresolved, ToolEffectState: ToolEffectUnknown,
		UnknownEffectSource: UnknownEffectRuntimeMCP,
		ErrorClass:          "tool_outcome_unknown",
	}
	if err := ValidateTerminalReplay(AdmissionReleased, &report, report); err != nil {
		t.Fatalf("replay after Runtime barrier: %v", err)
	}
	different := report
	different.ErrorClass = "different_outcome"
	if err := ValidateTerminalReplay(AdmissionReleased, &report, different); err == nil {
		t.Fatal("accepted a different replayed terminal report")
	}
}

func TestClientMCPUnknownEffectCannotUseRuntimeAbsenceBarrier(t *testing.T) {
	t.Parallel()

	admission, err := NewRunAdmission("admission-1", "agent-1", "runtime-1")
	if err != nil {
		t.Fatalf("create admission: %v", err)
	}
	report := TerminalReport{
		Class: TerminalUnresolved, ToolEffectState: ToolEffectUnknown,
		UnknownEffectSource: UnknownEffectClientMCP, ErrorClass: "tool_outcome_unknown",
	}
	if err := admission.Finish(report, time.Unix(1, 0).UTC()); err != nil {
		t.Fatalf("finish admission: %v", err)
	}
	if err := admission.ReleaseAfterRuntimeAbsent(
		"operation-1", "runtime-1", time.Unix(2, 0).UTC(),
	); err == nil {
		t.Fatal("Runtime absence released a client MCP unknown effect")
	}
}
