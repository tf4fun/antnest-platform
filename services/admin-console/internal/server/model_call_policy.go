package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const modelCallPolicyMaximumValue = 9007199254740991
const modelCallPolicyUpstreamPath = "/internal/model-call-policy"

var modelCallPolicyTopFields = []string{"organization_id", "revision", "unknown_cost", "run_caps", "daily", "monthly"}
var modelCallPolicyRunMembers = []string{"max_input_tokens", "max_output_tokens", "max_cost_usd_micros"}
var modelCallPolicyPeriodMembers = []string{"soft_cost_usd_micros", "hard_cost_usd_micros"}

type browserRunBudget struct {
	MaxInputTokens   *int64 `json:"max_input_tokens,omitempty"`
	MaxOutputTokens  *int64 `json:"max_output_tokens,omitempty"`
	MaxCostUSDMicros *int64 `json:"max_cost_usd_micros,omitempty"`
}

func (budget *browserRunBudget) UnmarshalJSON(raw []byte) error {
	fields, err := strictNestedFields(raw, modelCallPolicyRunMembers, false)
	if err != nil {
		return err
	}
	type wire browserRunBudget
	var decoded wire
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	for _, name := range modelCallPolicyRunMembers {
		member, exists := fields[name]
		if !exists {
			continue
		}
		var value int64
		if err := json.Unmarshal(member, &value); err != nil || value < 0 || value > modelCallPolicyMaximumValue {
			return fmt.Errorf("invalid run budget member %s", name)
		}
	}
	*budget = browserRunBudget(decoded)
	return nil
}

func (budget browserRunBudget) empty() bool {
	return budget.MaxInputTokens == nil && budget.MaxOutputTokens == nil && budget.MaxCostUSDMicros == nil
}

type browserPeriodCaps struct {
	SoftCostUSDMicros *int64 `json:"soft_cost_usd_micros,omitempty"`
	HardCostUSDMicros *int64 `json:"hard_cost_usd_micros,omitempty"`
}

func (caps *browserPeriodCaps) UnmarshalJSON(raw []byte) error {
	fields, err := strictNestedFields(raw, modelCallPolicyPeriodMembers, false)
	if err != nil {
		return err
	}
	type wire browserPeriodCaps
	var decoded wire
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	for _, name := range modelCallPolicyPeriodMembers {
		member, exists := fields[name]
		if !exists {
			continue
		}
		var value int64
		if err := json.Unmarshal(member, &value); err != nil || value < 0 || value > modelCallPolicyMaximumValue {
			return fmt.Errorf("invalid period cap member %s", name)
		}
	}
	if decoded.SoftCostUSDMicros != nil && decoded.HardCostUSDMicros != nil &&
		*decoded.SoftCostUSDMicros > *decoded.HardCostUSDMicros {
		return fmt.Errorf("soft cap exceeds hard cap")
	}
	*caps = browserPeriodCaps(decoded)
	return nil
}

func (caps browserPeriodCaps) empty() bool {
	return caps.SoftCostUSDMicros == nil && caps.HardCostUSDMicros == nil
}

// strictNestedFields decodes a JSON object into a field map, rejecting null
// members, unknown or case-aliased names; required==true demands every name.
func strictNestedFields(raw []byte, names []string, required bool) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return nil, err
	}
	known := make(map[string]bool, len(names))
	for _, name := range names {
		known[name] = true
		value, exists := fields[name]
		if required && !exists {
			return nil, fmt.Errorf("missing required member %s", name)
		}
		if exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, fmt.Errorf("null member %s", name)
		}
	}
	for key := range fields {
		if known[key] {
			continue
		}
		for name := range known {
			if strings.EqualFold(key, name) {
				return nil, fmt.Errorf("ambiguous member %s", key)
			}
		}
		return nil, fmt.Errorf("unknown member %s", key)
	}
	return fields, nil
}

type modelCallPolicyInput struct {
	ExpectedRevision  int64             `json:"expected_revision"`
	UnknownCost       string            `json:"unknown_cost"`
	RunCaps           browserRunBudget  `json:"run_caps"`
	Daily             browserPeriodCaps `json:"daily"`
	Monthly           browserPeriodCaps `json:"monthly"`
	ExpectedPrincipal [2]string         `json:"expected_principal"`
}

func (input *modelCallPolicyInput) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return err
	}
	var wire struct {
		ExpectedRevision  int64             `json:"expected_revision"`
		UnknownCost       string            `json:"unknown_cost"`
		RunCaps           browserRunBudget  `json:"run_caps"`
		Daily             browserPeriodCaps `json:"daily"`
		Monthly           browserPeriodCaps `json:"monthly"`
		ExpectedPrincipal []string          `json:"expected_principal"`
	}
	if err := serviceauth.DecodeObject(raw, &wire); err != nil {
		return err
	}
	for _, name := range []string{"expected_revision", "unknown_cost", "run_caps", "daily", "monthly", "expected_principal"} {
		value, exists := fields[name]
		if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("missing required model policy member %s", name)
		}
		delete(fields, name)
	}
	if len(fields) != 0 {
		return fmt.Errorf("unknown model policy member")
	}
	if wire.ExpectedRevision < 0 || wire.ExpectedRevision > modelCallPolicyMaximumValue ||
		(wire.UnknownCost != "allow" && wire.UnknownCost != "deny") ||
		len(wire.ExpectedPrincipal) != 2 || wire.ExpectedPrincipal[0] == "" || wire.ExpectedPrincipal[1] == "" {
		return fmt.Errorf("invalid model policy value")
	}
	input.ExpectedRevision = wire.ExpectedRevision
	input.UnknownCost = wire.UnknownCost
	input.RunCaps = wire.RunCaps
	input.Daily = wire.Daily
	input.Monthly = wire.Monthly
	input.ExpectedPrincipal = [2]string{wire.ExpectedPrincipal[0], wire.ExpectedPrincipal[1]}
	return nil
}

// Upstream decode keeps only the contracted members; unrelated private fields
// are stripped, while recognized names must appear exactly and decode strictly.
type controllerModelCallPolicy struct {
	OrganizationID string            `json:"organization_id"`
	Revision       int64             `json:"revision"`
	UnknownCost    string            `json:"unknown_cost"`
	RunCaps        browserRunBudget  `json:"run_caps"`
	Daily          browserPeriodCaps `json:"daily"`
	Monthly        browserPeriodCaps `json:"monthly"`
}

// filterNestedCaps keeps only recognized members of a nested cap object for
// strict typed decoding; case-aliased spellings of known members are rejected
// rather than silently overriding, and private members are stripped.
func filterNestedCaps(raw json.RawMessage, members []string, target any) error {
	var nested map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &nested); err != nil {
		return err
	}
	known := make(map[string]bool, len(members))
	for _, member := range members {
		known[member] = true
	}
	for key := range nested {
		if known[key] {
			continue
		}
		for _, member := range members {
			if strings.EqualFold(key, member) {
				return fmt.Errorf("ambiguous upstream cap member %s", key)
			}
		}
		delete(nested, key)
	}
	filtered, err := json.Marshal(nested)
	if err != nil {
		return err
	}
	return serviceauth.DecodeObject(filtered, target)
}

func (policy *controllerModelCallPolicy) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return err
	}
	canonical := make(map[string]bool, len(modelCallPolicyTopFields))
	for _, name := range modelCallPolicyTopFields {
		canonical[name] = true
	}
	for key := range fields {
		if canonical[key] {
			continue
		}
		for _, name := range modelCallPolicyTopFields {
			if strings.EqualFold(key, name) {
				return fmt.Errorf("ambiguous upstream policy member %s", key)
			}
		}
	}
	for _, name := range modelCallPolicyTopFields {
		value, exists := fields[name]
		if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("missing upstream policy member %s", name)
		}
	}
	var decoded controllerModelCallPolicy
	if err := json.Unmarshal(fields["organization_id"], &decoded.OrganizationID); err != nil || decoded.OrganizationID == "" {
		return fmt.Errorf("invalid upstream policy organization")
	}
	if err := json.Unmarshal(fields["revision"], &decoded.Revision); err != nil ||
		decoded.Revision < 0 || decoded.Revision > modelCallPolicyMaximumValue {
		return fmt.Errorf("invalid upstream policy revision")
	}
	if err := json.Unmarshal(fields["unknown_cost"], &decoded.UnknownCost); err != nil ||
		(decoded.UnknownCost != "allow" && decoded.UnknownCost != "deny") {
		return fmt.Errorf("invalid upstream policy unknown_cost")
	}
	if err := filterNestedCaps(fields["run_caps"], modelCallPolicyRunMembers, &decoded.RunCaps); err != nil {
		return err
	}
	if err := filterNestedCaps(fields["daily"], modelCallPolicyPeriodMembers, &decoded.Daily); err != nil {
		return err
	}
	if err := filterNestedCaps(fields["monthly"], modelCallPolicyPeriodMembers, &decoded.Monthly); err != nil {
		return err
	}
	if decoded.Revision == 0 && (decoded.UnknownCost != "allow" ||
		!decoded.RunCaps.empty() || !decoded.Daily.empty() || !decoded.Monthly.empty()) {
		return fmt.Errorf("upstream default policy carries configured values")
	}
	*policy = decoded
	return nil
}

func browserModelCallPolicy(policy controllerModelCallPolicy) ([]byte, error) {
	return json.Marshal(struct {
		Revision    int64             `json:"revision"`
		UnknownCost string            `json:"unknown_cost"`
		RunCaps     browserRunBudget  `json:"run_caps"`
		Daily       browserPeriodCaps `json:"daily"`
		Monthly     browserPeriodCaps `json:"monthly"`
	}{
		Revision: policy.Revision, UnknownCost: policy.UnknownCost,
		RunCaps: policy.RunCaps, Daily: policy.Daily, Monthly: policy.Monthly,
	})
}

func decodeUpstreamModelCallPolicy(payload []byte, organizationID string) (controllerModelCallPolicy, error) {
	var policy controllerModelCallPolicy
	if err := json.Unmarshal(payload, &policy); err != nil {
		return policy, err
	}
	if policy.OrganizationID != organizationID {
		return policy, errors.New("upstream policy belongs to another organization")
	}
	return policy, nil
}

func (h *handler) getModelCallPolicy(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	if request.URL.RawQuery != "" || request.ContentLength > 0 || len(request.TransferEncoding) != 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Organization model policy reads take no input")
		return
	}
	result, ok := h.read(response, request, upstream.AgentController, http.MethodGet,
		modelCallPolicyUpstreamPath, "organization_id="+url.QueryEscape(actor.OrganizationID), nil)
	if !ok {
		return
	}
	if result.status != http.StatusOK {
		writeModelCallPolicyFailure(response, result)
		return
	}
	h.writeProjected(response, request, upstream.AgentController, result,
		func(payload []byte) ([]byte, error) {
			policy, err := decodeUpstreamModelCallPolicy(payload, actor.OrganizationID)
			if err != nil {
				return nil, err
			}
			return browserModelCallPolicy(policy)
		})
}

func (h *handler) setModelCallPolicy(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	if request.URL.RawQuery != "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Organization model policy writes take no query")
		return
	}
	var input modelCallPolicyInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if input.ExpectedPrincipal != [2]string{actor.OrganizationID, actor.UserID} {
		writeError(response, http.StatusConflict, "principal_changed", "The signed-in account changed")
		return
	}
	if len(request.Header.Values("Idempotency-Key")) != 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Exactly one Idempotency-Key is required")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "model-policy")
	if !ok {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"actor_principal_id": actor.UserID, "expected_revision": input.ExpectedRevision,
		"unknown_cost": input.UnknownCost, "run_caps": input.RunCaps,
		"daily": input.Daily, "monthly": input.Monthly,
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encoding_failed", "Request could not be encoded")
		return
	}
	result, ok := h.read(response, request, upstream.AgentController, http.MethodPut,
		modelCallPolicyUpstreamPath, "", payload)
	if !ok {
		return
	}
	if result.status != http.StatusOK {
		writeModelCallPolicyFailure(response, result)
		return
	}
	h.writeProjected(response, request, upstream.AgentController, result,
		func(body []byte) ([]byte, error) {
			policy, err := decodeUpstreamModelCallPolicy(body, actor.OrganizationID)
			if err != nil {
				return nil, err
			}
			if policy.Revision != input.ExpectedRevision+1 || policy.UnknownCost != input.UnknownCost ||
				!runBudgetsEqual(policy.RunCaps, input.RunCaps) ||
				!periodCapsEqual(policy.Daily, input.Daily) || !periodCapsEqual(policy.Monthly, input.Monthly) {
				return nil, errors.New("upstream policy does not match the accepted request")
			}
			return browserModelCallPolicy(policy)
		})
}

func runBudgetsEqual(left, right browserRunBudget) bool {
	return pointersEqual(left.MaxInputTokens, right.MaxInputTokens) &&
		pointersEqual(left.MaxOutputTokens, right.MaxOutputTokens) &&
		pointersEqual(left.MaxCostUSDMicros, right.MaxCostUSDMicros)
}

func periodCapsEqual(left, right browserPeriodCaps) bool {
	return pointersEqual(left.SoftCostUSDMicros, right.SoftCostUSDMicros) &&
		pointersEqual(left.HardCostUSDMicros, right.HardCostUSDMicros)
}

func pointersEqual(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

// Only known public failure code/status pairs are relayed, with static
// messages; mismatched or private codes collapse to a generic bad gateway.
var modelCallPolicyFailureStatus = map[string]int{
	"resource_version_conflict":                 http.StatusConflict,
	"request_id_conflict":                       http.StatusConflict,
	"execution_configuration_capacity_exceeded": http.StatusConflict,
	"forbidden":                       http.StatusForbidden,
	"caller_not_allowed":              http.StatusForbidden,
	"organization_mismatch":           http.StatusForbidden,
	"actor_mismatch":                  http.StatusForbidden,
	"service_unauthenticated":         http.StatusUnauthorized,
	"caller_context_required":         http.StatusUnauthorized,
	"caller_context_invalid":          http.StatusUnauthorized,
	"invalid_request":                 http.StatusBadRequest,
	"dependency_unavailable":          http.StatusServiceUnavailable,
	"identity_dependency_unavailable": http.StatusServiceUnavailable,
	"internal_error":                  http.StatusInternalServerError,
}

func writeModelCallPolicyFailure(response http.ResponseWriter, result bufferedResponse) {
	var envelope struct {
		Code string `json:"code"`
	}
	var code string
	if json.Unmarshal(result.body, &envelope) == nil {
		code = envelope.Code
	}
	if status, known := modelCallPolicyFailureStatus[code]; known && result.status == status {
		writeError(response, status, code, "The platform rejected the organization model policy request")
		return
	}
	writeError(response, http.StatusBadGateway, "upstream_error", "The platform model policy request failed")
}
