package domain

import "fmt"

type EffectState string

const (
	EffectCompleted  EffectState = "completed"
	EffectNotStarted EffectState = "not_started"
	EffectUnknown    EffectState = "unknown"
)

// EffectOutcome describes what is known about a remote side effect. Unknown
// is deliberately not retryable without observing the external resource.
type EffectOutcome struct {
	State  EffectState `json:"state"`
	Code   string      `json:"code,omitempty"`
	Detail string      `json:"detail,omitempty"`
}

func (o EffectOutcome) Validate() error {
	switch o.State {
	case EffectCompleted, EffectNotStarted, EffectUnknown:
		return nil
	default:
		return fmt.Errorf("unsupported effect state %q", o.State)
	}
}
