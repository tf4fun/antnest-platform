package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

type templateModelRetry struct {
	Max    int64 `json:"max"`
	BaseMS int64 `json:"base_ms"`
	CapMS  int64 `json:"cap_ms"`
}

func (retry *templateModelRetry) UnmarshalJSON(raw []byte) error {
	if _, err := strictNestedFields(raw, []string{"max", "base_ms", "cap_ms"}, true); err != nil {
		return err
	}
	type wire templateModelRetry
	var decoded wire
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	if decoded.Max < 0 || decoded.Max > 8 || decoded.BaseMS < 1 || decoded.BaseMS > 30000 ||
		decoded.CapMS < decoded.BaseMS || decoded.CapMS > 30000 {
		return fmt.Errorf("invalid model retry policy")
	}
	*retry = templateModelRetry(decoded)
	return nil
}

var templatePolicyFieldNames = []string{"model_retry", "failover", "run_budget"}

// validateTemplatePolicyFields restores the semantics plain pointer decoding
// loses: explicitly present policy members must not be null, case-aliased
// spellings of known members are rejected, and failover is enumerated. Nested
// member shapes are already strictly validated by the typed decoding.
func validateTemplatePolicyFields(fields map[string]json.RawMessage, policy *templateModelPolicyInput) error {
	for _, name := range templatePolicyFieldNames {
		if raw, exists := fields[name]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("null %s", name)
		}
	}
	for key := range fields {
		for _, name := range templatePolicyFieldNames {
			if key != name && strings.EqualFold(key, name) {
				return fmt.Errorf("ambiguous template policy member %s", key)
			}
		}
	}
	if policy.Failover != nil && *policy.Failover != "never" && *policy.Failover != "before_output" {
		return fmt.Errorf("invalid failover")
	}
	return nil
}

type templateModelPolicyInput struct {
	ModelRetry *templateModelRetry `json:"model_retry,omitempty"`
	Failover   *string             `json:"failover,omitempty"`
	RunBudget  *browserRunBudget   `json:"run_budget,omitempty"`
}

func forwardTemplateModelPolicy(payload map[string]any, policy templateModelPolicyInput) {
	if policy.ModelRetry != nil {
		payload["model_retry"] = policy.ModelRetry
	}
	if policy.Failover != nil {
		payload["failover"] = *policy.Failover
	}
	if policy.RunBudget != nil {
		payload["run_budget"] = policy.RunBudget
	}
}
