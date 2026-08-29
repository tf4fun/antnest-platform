package runtimeprotocol

import (
	"fmt"
	"strings"
)

type EffectDisposition string

const (
	EffectCompleted  EffectDisposition = "completed"
	EffectNotStarted EffectDisposition = "not_started"
	EffectUnknown    EffectDisposition = "unknown"
)

func (d EffectDisposition) Validate() error {
	switch d {
	case EffectCompleted, EffectNotStarted, EffectUnknown:
		return nil
	default:
		return fmt.Errorf("invalid effect disposition %q", d)
	}
}

// Outcome describes what is known about a side effect. Reason explains the
// observation; it must never be used as a second state machine.
type Outcome struct {
	Disposition EffectDisposition `json:"disposition"`
	Reason      string            `json:"reason"`
	Message     string            `json:"message,omitempty"`
}

func (o Outcome) Validate() error {
	if err := o.Disposition.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(o.Reason) == "" {
		return fmt.Errorf("outcome reason is required")
	}
	if len(o.Message) > 4096 {
		return fmt.Errorf("outcome message exceeds 4096 bytes")
	}
	return nil
}
