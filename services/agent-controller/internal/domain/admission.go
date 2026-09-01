package domain

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

var errorClassPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

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

type UnknownEffectSource string

const (
	UnknownEffectRuntimeMCP   UnknownEffectSource = "runtime_mcp"
	UnknownEffectClientMCP    UnknownEffectSource = "client_mcp"
	UnknownEffectUnclassified UnknownEffectSource = "unclassified"
)

type TerminalReport struct {
	Class               TerminalClass       `json:"terminal_class"`
	ToolEffectState     ToolEffectState     `json:"tool_effect_state"`
	UnknownEffectSource UnknownEffectSource `json:"unknown_effect_source,omitempty"`
	StopReason          string              `json:"stop_reason"`
	ErrorClass          string              `json:"error_class"`
}

func ValidateTerminalReport(report TerminalReport) (AdmissionState, error) {
	return report.admissionState()
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
	if admission.report == nil || admission.report.UnknownEffectSource != UnknownEffectRuntimeMCP {
		return fmt.Errorf("only a Runtime MCP unknown effect can use the Runtime absence barrier")
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
		if !settledEffect(report.ToolEffectState) || !validStopReason(report.StopReason) || report.ErrorClass != "" {
			return "", fmt.Errorf("completed report is invalid")
		}
		if report.UnknownEffectSource != "" {
			return "", fmt.Errorf("completed report cannot carry an unknown effect source")
		}
		return AdmissionReleased, nil
	case TerminalCancelled:
		if !settledEffect(report.ToolEffectState) || report.StopReason != "" || report.ErrorClass != "" {
			return "", fmt.Errorf("cancelled report is invalid")
		}
		if report.UnknownEffectSource != "" {
			return "", fmt.Errorf("cancelled report cannot carry an unknown effect source")
		}
		return AdmissionReleased, nil
	case TerminalFailed:
		if !settledEffect(report.ToolEffectState) || report.StopReason != "" ||
			!errorClassPattern.MatchString(report.ErrorClass) {
			return "", fmt.Errorf("failed report is invalid")
		}
		if report.UnknownEffectSource != "" {
			return "", fmt.Errorf("failed report cannot carry an unknown effect source")
		}
		return AdmissionReleased, nil
	case TerminalUnresolved:
		if report.ToolEffectState != ToolEffectUnknown || report.StopReason != "" ||
			!errorClassPattern.MatchString(report.ErrorClass) ||
			!validUnknownEffectSource(report.UnknownEffectSource) {
			return "", fmt.Errorf("unresolved report must preserve an unknown Tool effect")
		}
		return AdmissionBlockedUnknownEffect, nil
	default:
		return "", fmt.Errorf("unknown terminal class %q", report.Class)
	}
}

func validUnknownEffectSource(source UnknownEffectSource) bool {
	return source == UnknownEffectRuntimeMCP || source == UnknownEffectClientMCP ||
		source == UnknownEffectUnclassified
}

func ValidateTerminalReplay(
	currentState AdmissionState,
	existing *TerminalReport,
	requested TerminalReport,
) error {
	resultingState, err := requested.admissionState()
	if err != nil {
		return err
	}
	if existing == nil || *existing != requested {
		return fmt.Errorf("admission already has a different terminal report")
	}
	if currentState == resultingState {
		return nil
	}
	if resultingState == AdmissionBlockedUnknownEffect && currentState == AdmissionReleased {
		return nil
	}
	return fmt.Errorf("admission state %s does not match its terminal report", currentState)
}

func validStopReason(reason string) bool {
	switch reason {
	case "end_turn", "max_tokens", "max_turn_requests", "refusal":
		return true
	default:
		return false
	}
}

func settledEffect(state ToolEffectState) bool {
	return state == ToolEffectNone || state == ToolEffectSettled
}
