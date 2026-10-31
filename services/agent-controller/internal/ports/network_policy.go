package ports

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

// NetworkPolicyReference addresses an immutable Egress-owned revision.
type NetworkPolicyReference struct {
	PolicyID string `json:"policy_id"`
	Revision uint64 `json:"revision"`
}

func (ref NetworkPolicyReference) Valid() bool {
	if ref.Revision == 0 || len(ref.PolicyID) == 0 || len(ref.PolicyID) > 255 {
		return false
	}
	for _, value := range []byte(ref.PolicyID) {
		if value < '!' || value > '~' {
			return false
		}
	}
	return true
}

type NetworkPolicySpec struct {
	SchemaVersion int                 `json:"schema_version"`
	Action        string              `json:"action,omitempty"`
	Default       string              `json:"default,omitempty"`
	Rules         []NetworkPolicyRule `json:"rules,omitempty"`
}

type NetworkPolicyRule struct {
	Action   string              `json:"action"`
	CIDRs    []string            `json:"cidrs,omitempty"`
	Domains  []string            `json:"domains,omitempty"`
	Ports    []NetworkPolicyPort `json:"ports,omitempty"`
	Protocol string              `json:"protocol,omitempty"`
}

type NetworkPolicyPort struct {
	From  uint16 `json:"from"`
	To    uint16 `json:"to"`
	Range bool   `json:"-"`
}

var policyDomainPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func (spec NetworkPolicySpec) MarshalJSON() ([]byte, error) {
	switch spec.SchemaVersion {
	case 1:
		return json.Marshal(struct {
			SchemaVersion int    `json:"schema_version"`
			Action        string `json:"action"`
		}{SchemaVersion: 1, Action: spec.Action})
	case 2:
		rules := spec.Rules
		if rules == nil {
			rules = []NetworkPolicyRule{}
		}
		return json.Marshal(struct {
			SchemaVersion int                 `json:"schema_version"`
			Default       string              `json:"default"`
			Rules         []NetworkPolicyRule `json:"rules"`
		}{SchemaVersion: 2, Default: spec.Default, Rules: rules})
	default:
		return nil, fmt.Errorf("unsupported policy schema version")
	}
}

func (rule NetworkPolicyRule) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Action   string              `json:"action"`
		CIDRs    []string            `json:"cidrs,omitempty"`
		Domains  []string            `json:"domains,omitempty"`
		Ports    []NetworkPolicyPort `json:"ports,omitempty"`
		Protocol string              `json:"protocol,omitempty"`
	}{
		Action:   rule.Action,
		CIDRs:    rule.CIDRs,
		Domains:  rule.Domains,
		Ports:    rule.Ports,
		Protocol: rule.Protocol,
	})
}

func (port NetworkPolicyPort) MarshalJSON() ([]byte, error) {
	if !port.Range && port.From == port.To {
		return json.Marshal(port.From)
	}
	return json.Marshal(struct {
		From uint16 `json:"from"`
		To   uint16 `json:"to"`
	}{From: port.From, To: port.To})
}

func (spec *NetworkPolicySpec) UnmarshalJSON(raw []byte) error {
	var fields struct {
		SchemaVersion json.RawMessage `json:"schema_version"`
		Action        json.RawMessage `json:"action"`
		Default       json.RawMessage `json:"default"`
		Rules         json.RawMessage `json:"rules"`
	}
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return err
	}
	version, err := decodeUint(fields.SchemaVersion, "schema_version")
	if err != nil {
		return err
	}
	switch version {
	case 1:
		if fields.Action == nil || fields.Default != nil || fields.Rules != nil {
			return fmt.Errorf("schema_version 1 carries action only")
		}
		action, err := decodeString(fields.Action, "action")
		if err != nil {
			return err
		}
		spec.SchemaVersion = 1
		spec.Action = action
		spec.Default = ""
		spec.Rules = nil
	case 2:
		if fields.Action != nil || fields.Default == nil || fields.Rules == nil {
			return fmt.Errorf("schema_version 2 carries default and rules only")
		}
		defaultAction, err := decodeString(fields.Default, "default")
		if err != nil {
			return err
		}
		var rawRules []json.RawMessage
		if err := decodeList(fields.Rules, &rawRules, "rules"); err != nil {
			return err
		}
		if len(rawRules) > 128 {
			return fmt.Errorf("policy rules exceed 128")
		}
		rules := make([]NetworkPolicyRule, 0, len(rawRules))
		for _, entry := range rawRules {
			rule, err := decodePolicyRule(entry)
			if err != nil {
				return err
			}
			rules = append(rules, rule)
		}
		spec.SchemaVersion = 2
		spec.Action = ""
		spec.Default = defaultAction
		spec.Rules = rules
	default:
		return fmt.Errorf("unsupported policy schema version")
	}
	if !spec.Valid() {
		return fmt.Errorf("invalid policy spec")
	}
	return nil
}

func decodePolicyRule(raw json.RawMessage) (NetworkPolicyRule, error) {
	var fields struct {
		Action   json.RawMessage `json:"action"`
		CIDRs    json.RawMessage `json:"cidrs"`
		Domains  json.RawMessage `json:"domains"`
		Ports    json.RawMessage `json:"ports"`
		Protocol json.RawMessage `json:"protocol"`
	}
	var rule NetworkPolicyRule
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return rule, err
	}
	action, err := decodeString(fields.Action, "action")
	if err != nil {
		return rule, err
	}
	rule.Action = action
	if err := decodeStringList(fields.CIDRs, &rule.CIDRs, "cidrs"); err != nil {
		return rule, err
	}
	if err := decodeStringList(fields.Domains, &rule.Domains, "domains"); err != nil {
		return rule, err
	}
	if len(rule.CIDRs) > 0 && len(rule.Domains) > 0 {
		return rule, fmt.Errorf("cidrs and domains are mutually exclusive")
	}
	if fields.Ports != nil {
		var rawPorts []json.RawMessage
		if err := decodeList(fields.Ports, &rawPorts, "ports"); err != nil {
			return rule, err
		}
		for _, entry := range rawPorts {
			port, err := decodePolicyPort(entry)
			if err != nil {
				return rule, err
			}
			rule.Ports = append(rule.Ports, port)
		}
	}
	if fields.Protocol != nil {
		protocol, err := decodeString(fields.Protocol, "protocol")
		if err != nil {
			return rule, err
		}
		if protocol != "tcp" {
			return rule, fmt.Errorf("protocol must be tcp")
		}
		rule.Protocol = protocol
	}
	if fields.CIDRs != nil && len(rule.CIDRs) == 0 {
		return rule, fmt.Errorf("cidrs requires 1-64 entries")
	}
	if fields.Domains != nil && len(rule.Domains) == 0 {
		return rule, fmt.Errorf("domains requires 1-64 entries")
	}
	if fields.Ports != nil && len(rule.Ports) == 0 {
		return rule, fmt.Errorf("ports requires 1-64 entries")
	}
	if !rule.valid() {
		return rule, fmt.Errorf("invalid policy rule")
	}
	return rule, nil
}

func decodePolicyPort(raw json.RawMessage) (NetworkPolicyPort, error) {
	var port NetworkPolicyPort
	var single uint64
	if err := json.Unmarshal(raw, &single); err == nil {
		if single > 65535 {
			return port, fmt.Errorf("port out of range")
		}
		return NetworkPolicyPort{From: uint16(single), To: uint16(single), Range: false}, nil
	}
	var fields struct {
		From json.RawMessage `json:"from"`
		To   json.RawMessage `json:"to"`
	}
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return port, err
	}
	from, err := decodeUint(fields.From, "from")
	if err != nil {
		return port, err
	}
	to, err := decodeUint(fields.To, "to")
	if err != nil {
		return port, err
	}
	if from > 65535 || to > 65535 {
		return port, fmt.Errorf("port out of range")
	}
	return NetworkPolicyPort{From: uint16(from), To: uint16(to), Range: true}, nil
}

func decodeUint(raw json.RawMessage, name string) (uint64, error) {
	if raw == nil || isJSONNull(raw) {
		return 0, fmt.Errorf("%s is required", name)
	}
	var value uint64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, fmt.Errorf("%s must be an unsigned integer", name)
	}
	return value, nil
}

func decodeString(raw json.RawMessage, name string) (string, error) {
	if raw == nil || isJSONNull(raw) {
		return "", fmt.Errorf("%s is required", name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", name)
	}
	return value, nil
}

func decodeList(raw json.RawMessage, target *[]json.RawMessage, name string) error {
	if raw == nil || isJSONNull(raw) {
		return fmt.Errorf("%s is required", name)
	}
	return json.Unmarshal(raw, target)
}

func decodeStringList(raw json.RawMessage, target *[]string, name string) error {
	if raw == nil {
		return nil
	}
	if isJSONNull(raw) {
		return fmt.Errorf("%s must not be null", name)
	}
	return json.Unmarshal(raw, target)
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func (spec NetworkPolicySpec) Valid() bool {
	switch spec.SchemaVersion {
	case 1:
		return (spec.Action == "allow_all" || spec.Action == "deny_all") &&
			spec.Default == "" && len(spec.Rules) == 0
	case 2:
		if (spec.Default != "allow" && spec.Default != "deny") || spec.Action != "" ||
			len(spec.Rules) > 128 {
			return false
		}
		for _, rule := range spec.Rules {
			if !rule.valid() {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func (rule NetworkPolicyRule) valid() bool {
	if rule.Action != "allow" && rule.Action != "deny" {
		return false
	}
	if len(rule.CIDRs) > 0 && len(rule.Domains) > 0 {
		return false
	}
	if len(rule.CIDRs) > 64 || len(rule.Domains) > 64 || len(rule.Ports) > 64 {
		return false
	}
	if rule.Protocol != "" && rule.Protocol != "tcp" {
		return false
	}
	for _, cidr := range rule.CIDRs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil || !prefix.Addr().Is4() || prefix.Masked().String() != cidr {
			return false
		}
	}
	for _, domain := range rule.Domains {
		if len(domain) > 253 || !policyDomainPattern.MatchString(domain) {
			return false
		}
	}
	for _, port := range rule.Ports {
		if port.From == 0 || port.From > port.To {
			return false
		}
	}
	return true
}

func (spec NetworkPolicySpec) Equal(other NetworkPolicySpec) bool {
	left, err := json.Marshal(spec)
	if err != nil {
		return false
	}
	right, err := json.Marshal(other)
	if err != nil {
		return false
	}
	return bytes.Equal(left, right)
}

func (spec NetworkPolicySpec) Reference(organizationID, agentID string) (NetworkPolicyReference, error) {
	if !spec.Valid() {
		return NetworkPolicyReference{}, fmt.Errorf("invalid policy spec")
	}
	specJSON, err := json.Marshal(spec)
	if err != nil {
		return NetworkPolicyReference{}, err
	}
	organizationJSON, err := json.Marshal(organizationID)
	if err != nil {
		return NetworkPolicyReference{}, err
	}
	agentJSON, err := json.Marshal(agentID)
	if err != nil {
		return NetworkPolicyReference{}, err
	}
	canonical := append([]byte{'['}, organizationJSON...)
	canonical = append(canonical, ',')
	canonical = append(canonical, agentJSON...)
	canonical = append(canonical, ',')
	canonical = append(canonical, specJSON...)
	canonical = append(canonical, ']')
	sum := sha256.Sum256(canonical)
	return NetworkPolicyReference{
		PolicyID: "custom/" + hex.EncodeToString(sum[:]),
		Revision: 1,
	}, nil
}

type NetworkPolicyRevision struct {
	NetworkPolicyReference
	Spec   NetworkPolicySpec `json:"spec"`
	Digest string            `json:"digest"`
}

type NetworkPolicyAssignment struct {
	AgentID string `json:"agent_id"`
	NetworkPolicyReference
	ResourceVersion uint64 `json:"resource_version"`
}

type SetNetworkPolicy struct {
	NetworkPolicyReference
	ExpectedResourceVersion uint64 `json:"expected_resource_version"`
}

type NetworkAgentLookup interface {
	GetAgent(context.Context, string) (AgentRecord, error)
}

type NetworkPolicyClient interface {
	GetAgentNetwork(context.Context, string) (NetworkAttachment, error)
	GetAgentPolicyAssignment(context.Context, string) (NetworkPolicyAssignment, error)
	GetPolicyRevision(context.Context, NetworkPolicyReference) (NetworkPolicyRevision, error)
	SetAgentPolicyAssignment(context.Context, string, SetNetworkPolicy) (NetworkPolicyAssignment, error)
}

type NetworkPolicyRevisionWriter interface {
	PutPolicyRevision(context.Context, NetworkPolicyReference, NetworkPolicySpec) (NetworkPolicyRevision, error)
}
