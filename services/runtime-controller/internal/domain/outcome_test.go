package domain

import "testing"

func TestEffectOutcomeRequiresExplicitState(t *testing.T) {
	tests := []struct {
		name    string
		outcome EffectOutcome
		valid   bool
	}{
		{name: "completed", outcome: EffectOutcome{State: EffectCompleted}, valid: true},
		{name: "not started", outcome: EffectOutcome{State: EffectNotStarted, Code: "unavailable"}, valid: true},
		{name: "unknown", outcome: EffectOutcome{State: EffectUnknown, Code: "response_lost"}, valid: true},
		{name: "empty", outcome: EffectOutcome{}, valid: false},
		{name: "invalid", outcome: EffectOutcome{State: "maybe"}, valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.outcome.Validate()
			if test.valid && err != nil {
				t.Fatalf("valid outcome rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid outcome accepted")
			}
		})
	}
}
