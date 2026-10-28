package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const MaximumModelBudget int64 = 1<<53 - 1

type ModelRetryPolicy struct {
	Max    int `json:"max"`
	BaseMS int `json:"base_ms"`
	CapMS  int `json:"cap_ms"`
}

type RunBudget struct {
	MaxInputTokens   *int64 `json:"max_input_tokens,omitempty"`
	MaxOutputTokens  *int64 `json:"max_output_tokens,omitempty"`
	MaxCostUSDMicros *int64 `json:"max_cost_usd_micros,omitempty"`
}

func (policy *ModelRetryPolicy) Clone() *ModelRetryPolicy {
	if policy == nil {
		return nil
	}
	copy := *policy
	return &copy
}

func (budget *RunBudget) Clone() *RunBudget {
	if budget == nil {
		return nil
	}
	copy := *budget
	for _, target := range []**int64{&copy.MaxInputTokens, &copy.MaxOutputTokens, &copy.MaxCostUSDMicros} {
		if *target != nil {
			value := **target
			*target = &value
		}
	}
	return &copy
}

// Missing fields preserve immutable history. Effective defaults belong only to
// the current execution publication, after its own revision has advanced.
func ValidateModelCallPolicy(retry *ModelRetryPolicy, failover string, budget *RunBudget) error {
	if retry != nil && (retry.Max < 0 || retry.Max > 8 || retry.BaseMS < 1 || retry.CapMS < retry.BaseMS || retry.CapMS > 30000) {
		return fmt.Errorf("invalid model retry bounds")
	}
	if failover != "" && failover != "never" && failover != "before_output" {
		return fmt.Errorf("invalid model failover policy")
	}
	if budget != nil {
		for _, value := range []*int64{budget.MaxInputTokens, budget.MaxOutputTokens, budget.MaxCostUSDMicros} {
			if value != nil && (*value < 0 || *value > MaximumModelBudget) {
				return fmt.Errorf("invalid Run budget bound")
			}
		}
	}
	return nil
}

func (policy *ModelRetryPolicy) UnmarshalJSON(data []byte) error {
	var wire struct {
		Max    *int `json:"max"`
		BaseMS *int `json:"base_ms"`
		CapMS  *int `json:"cap_ms"`
	}
	if err := decodeModelPolicyObject(data, &wire, "max", "base_ms", "cap_ms"); err != nil {
		return err
	}
	if wire.Max == nil || wire.BaseMS == nil || wire.CapMS == nil {
		return fmt.Errorf("model retry requires max, base_ms and cap_ms")
	}
	value := ModelRetryPolicy{Max: *wire.Max, BaseMS: *wire.BaseMS, CapMS: *wire.CapMS}
	if err := ValidateModelCallPolicy(&value, "", nil); err != nil {
		return err
	}
	*policy = value
	return nil
}

func (budget *RunBudget) UnmarshalJSON(data []byte) error {
	type wireBudget RunBudget
	var wire wireBudget
	if err := decodeModelPolicyObject(data, &wire, "max_input_tokens", "max_output_tokens", "max_cost_usd_micros"); err != nil {
		return err
	}
	value := RunBudget(wire)
	if err := ValidateModelCallPolicy(nil, "", &value); err != nil {
		return err
	}
	*budget = value
	return nil
}

var modelCallPolicyIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

func ValidModelCallPolicyIdentifier(value string) bool {
	return modelCallPolicyIdentifier.MatchString(value)
}

type PeriodCaps struct {
	SoftCostUSDMicros *int64 `json:"soft_cost_usd_micros,omitempty"`
	HardCostUSDMicros *int64 `json:"hard_cost_usd_micros,omitempty"`
}

type OrganizationBudget struct {
	Revision    int64      `json:"revision"`
	UnknownCost string     `json:"unknown_cost"`
	RunCaps     RunBudget  `json:"run_caps"`
	Daily       PeriodCaps `json:"daily"`
	Monthly     PeriodCaps `json:"monthly"`
}

type ModelCallPolicy struct {
	OrganizationID string `json:"organization_id"`
	OrganizationBudget
}

func DefaultModelCallPolicy(organizationID string) ModelCallPolicy {
	return ModelCallPolicy{OrganizationID: organizationID,
		OrganizationBudget: OrganizationBudget{UnknownCost: "allow"}}
}

func (caps *PeriodCaps) Clone() *PeriodCaps {
	if caps == nil {
		return nil
	}
	copy := *caps
	for _, target := range []**int64{&copy.SoftCostUSDMicros, &copy.HardCostUSDMicros} {
		if *target != nil {
			value := **target
			*target = &value
		}
	}
	return &copy
}

func (budget *OrganizationBudget) Clone() *OrganizationBudget {
	if budget == nil {
		return nil
	}
	return &OrganizationBudget{Revision: budget.Revision, UnknownCost: budget.UnknownCost,
		RunCaps: *budget.RunCaps.Clone(), Daily: *budget.Daily.Clone(), Monthly: *budget.Monthly.Clone()}
}

func validatePeriodCaps(caps *PeriodCaps) error {
	if caps == nil {
		return nil
	}
	for _, value := range []*int64{caps.SoftCostUSDMicros, caps.HardCostUSDMicros} {
		if value != nil && (*value < 0 || *value > MaximumModelBudget) {
			return fmt.Errorf("invalid period budget bound")
		}
	}
	if caps.SoftCostUSDMicros != nil && caps.HardCostUSDMicros != nil && *caps.SoftCostUSDMicros > *caps.HardCostUSDMicros {
		return fmt.Errorf("invalid period budget ordering")
	}
	return nil
}

func periodCapsEmpty(caps PeriodCaps) bool {
	return caps.SoftCostUSDMicros == nil && caps.HardCostUSDMicros == nil
}

func (budget OrganizationBudget) Validate() error {
	if budget.Revision < 0 || budget.Revision > MaximumModelBudget ||
		(budget.UnknownCost != "allow" && budget.UnknownCost != "deny") {
		return fmt.Errorf("invalid organization budget")
	}
	if err := ValidateModelCallPolicy(nil, "", &budget.RunCaps); err != nil {
		return err
	}
	for _, caps := range []*PeriodCaps{&budget.Daily, &budget.Monthly} {
		if err := validatePeriodCaps(caps); err != nil {
			return err
		}
	}
	if budget.Revision == 0 && (budget.UnknownCost != "allow" ||
		budget.RunCaps.MaxInputTokens != nil || budget.RunCaps.MaxOutputTokens != nil || budget.RunCaps.MaxCostUSDMicros != nil ||
		!periodCapsEmpty(budget.Daily) || !periodCapsEmpty(budget.Monthly)) {
		return fmt.Errorf("invalid organization budget default")
	}
	return nil
}

func (policy ModelCallPolicy) Validate() error {
	if !ValidModelCallPolicyIdentifier(policy.OrganizationID) {
		return fmt.Errorf("invalid model call policy")
	}
	return policy.OrganizationBudget.Validate()
}

func (caps *PeriodCaps) UnmarshalJSON(data []byte) error {
	type wireCaps PeriodCaps
	var wire wireCaps
	if err := decodeModelPolicyObject(data, &wire, "soft_cost_usd_micros", "hard_cost_usd_micros"); err != nil {
		return err
	}
	value := PeriodCaps(wire)
	if err := validatePeriodCaps(&value); err != nil {
		return err
	}
	*caps = value
	return nil
}

func (policy *ModelCallPolicy) UnmarshalJSON(data []byte) error {
	var wire struct {
		OrganizationID *string     `json:"organization_id"`
		Revision       *int64      `json:"revision"`
		UnknownCost    *string     `json:"unknown_cost"`
		RunCaps        *RunBudget  `json:"run_caps"`
		Daily          *PeriodCaps `json:"daily"`
		Monthly        *PeriodCaps `json:"monthly"`
	}
	if err := decodeModelPolicyObject(data, &wire,
		"organization_id", "revision", "unknown_cost", "run_caps", "daily", "monthly"); err != nil {
		return err
	}
	if wire.OrganizationID == nil || wire.Revision == nil || wire.UnknownCost == nil ||
		wire.RunCaps == nil || wire.Daily == nil || wire.Monthly == nil {
		return fmt.Errorf("model call policy requires organization_id, revision, unknown_cost, run_caps, daily and monthly")
	}
	value := ModelCallPolicy{OrganizationID: *wire.OrganizationID, OrganizationBudget: OrganizationBudget{
		Revision: *wire.Revision, UnknownCost: *wire.UnknownCost,
		RunCaps: *wire.RunCaps, Daily: *wire.Daily, Monthly: *wire.Monthly,
	}}
	if err := value.Validate(); err != nil {
		return err
	}
	*policy = value
	return nil
}

func decodeModelPolicyObject(data []byte, target any, allowed ...string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields == nil {
		return fmt.Errorf("model policy must be an object")
	}
	for key, value := range fields {
		known := false
		for _, name := range allowed {
			if key == name {
				known = true
				break
			}
		}
		if !known || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("invalid model policy member %q", key)
		}
	}
	return json.Unmarshal(data, target)
}

// Pointer decoding cannot distinguish an omitted field from explicit null.
// This check is shared by public DTOs and persisted snapshot decoding.
func ValidateModelPolicyJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for key, raw := range fields {
		for _, name := range []string{"model_retry", "failover", "run_budget"} {
			if strings.EqualFold(key, name) && key != name {
				return fmt.Errorf("model policy field must use canonical spelling")
			}
		}
		if key != "model_retry" && key != "failover" && key != "run_budget" {
			continue
		}
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("model policy %s must not be null", key)
		}
		if key == "failover" {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				return err
			}
			if value == "" {
				return fmt.Errorf("explicit failover policy must not be empty")
			}
			if err := ValidateModelCallPolicy(nil, value, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

func (snapshot *TemplateRevisionSnapshot) UnmarshalJSON(data []byte) error {
	if err := ValidateModelPolicyJSON(data); err != nil {
		return err
	}
	type wireSnapshot TemplateRevisionSnapshot
	wire := wireSnapshot(*snapshot)
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*snapshot = TemplateRevisionSnapshot(wire)
	return nil
}

func (snapshot *AgentSpecSnapshot) UnmarshalJSON(data []byte) error {
	if err := ValidateModelPolicyJSON(data); err != nil {
		return err
	}
	type wireSnapshot AgentSpecSnapshot
	wire := wireSnapshot(*snapshot)
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*snapshot = AgentSpecSnapshot(wire)
	return nil
}
