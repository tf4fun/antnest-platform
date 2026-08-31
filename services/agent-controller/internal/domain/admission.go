package domain

import (
	"fmt"
	"strings"
	"time"
)

type AdmissionState string

const (
	AdmissionActive               AdmissionState = "active"
	AdmissionReleased             AdmissionState = "released"
	AdmissionBlockedUnknownEffect AdmissionState = "blocked_unknown_effect"
)

type TerminalClass string

const (
	TerminalCompleted  TerminalClass = "completed"
	TerminalCancelled  TerminalClass = "cancelled"
	TerminalFailed     TerminalClass = "failed"
	TerminalUnresolved TerminalClass = "unresolved"
)

type ToolEffectState string

const (
	ToolEffectNone    ToolEffectState = "none"
	ToolEffectSettled ToolEffectState = "settled"
	ToolEffectUnknown ToolEffectState = "unknown"
)

type TerminalReport struct {
	Class           TerminalClass
	ToolEffectState ToolEffectState
	StopReason      string
	ErrorClass      string
}

type RunAdmission struct {
	id                           string
	agentID                      string
	runtimeRevision              string
	state                        AdmissionState
	report                       *TerminalReport
	finishedAt                   *time.Time
	releasedByOperationRequestID string
	releasedAt                   *time.Time
}

func NewRunAdmission(id string, agentID string, runtimeRevision string) (*RunAdmission, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(agentID) == "" || strings.TrimSpace(runtimeRevision) == "" {
		return nil, fmt.Errorf("admission, Agent, and Runtime revision identities are required")
	}
	return &RunAdmission{id: id, agentID: agentID, runtimeRevision: runtimeRevision, state: AdmissionActive}, nil
}

func (admission *RunAdmission) State() AdmissionState { return admission.state }

func (admission *RunAdmission) Report() *TerminalReport {
	if admission.report == nil {
		return nil
	}
	report := *admission.report
	return &report
}

func (admission *RunAdmission) ReleasedByOperationRequestID() string {
	return admission.releasedByOperationRequestID
}

func (admission *RunAdmission) Finish(report TerminalReport, now time.Time) error {
	if admission.report != nil {
		if *admission.report == report {
			return nil
		}
		return fmt.Errorf("admission already has a different terminal report")
	}
	state, err := report.admissionState()
	if err != nil {
		return err
	}
	if now.IsZero() {
		return fmt.Errorf("finish time is required")
	}
	admission.report = &report
	admission.state = state
	admission.finishedAt = &now
	return nil
}

func (admission *RunAdmission) ReleaseAfterRuntimeAbsent(operationRequestID string, runtimeRevision string, now time.Time) error {
	if admission.state == AdmissionReleased && admission.releasedByOperationRequestID == operationRequestID {
		return nil
	}
	if admission.state != AdmissionBlockedUnknownEffect {
		return fmt.Errorf("admission state %s cannot use the Runtime absence barrier", admission.state)
	}
	if strings.TrimSpace(operationRequestID) == "" || runtimeRevision != admission.runtimeRevision || now.IsZero() {
		return fmt.Errorf("runtime absence evidence does not match the blocked admission")
	}
	admission.state = AdmissionReleased
	admission.releasedByOperationRequestID = operationRequestID
	admission.releasedAt = &now
	return nil
}

func (report TerminalReport) admissionState() (AdmissionState, error) {
	switch report.Class {
	case TerminalCompleted:
		if !settledEffect(report.ToolEffectState) || report.StopReason == "" || report.ErrorClass != "" {
			return "", fmt.Errorf("completed report is invalid")
		}
		return AdmissionReleased, nil
	case TerminalCancelled:
		if !settledEffect(report.ToolEffectState) || report.StopReason != "" {
			return "", fmt.Errorf("cancelled report is invalid")
		}
		return AdmissionReleased, nil
	case TerminalFailed:
		if !settledEffect(report.ToolEffectState) || report.StopReason != "" || report.ErrorClass == "" {
			return "", fmt.Errorf("failed report is invalid")
		}
		return AdmissionReleased, nil
	case TerminalUnresolved:
		if report.ToolEffectState != ToolEffectUnknown || report.StopReason != "" || report.ErrorClass == "" {
			return "", fmt.Errorf("unresolved report must preserve an unknown Tool effect")
		}
		return AdmissionBlockedUnknownEffect, nil
	default:
		return "", fmt.Errorf("unknown terminal class %q", report.Class)
	}
}

func settledEffect(state ToolEffectState) bool {
	return state == ToolEffectNone || state == ToolEffectSettled
}
