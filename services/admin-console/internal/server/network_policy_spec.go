package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

type networkPolicySpec struct {
	SchemaVersion int                 `json:"schema_version"`
	Action        string              `json:"action,omitempty"`
	Default       string              `json:"default,omitempty"`
	Rules         []networkPolicyRule `json:"rules,omitempty"`
}

type networkPolicyRule struct {
	Action   string              `json:"action"`
	CIDRs    []string            `json:"cidrs,omitempty"`
	Domains  []string            `json:"domains,omitempty"`
	Ports    []networkPolicyPort `json:"ports,omitempty"`
	Protocol string              `json:"protocol,omitempty"`
}

type networkPolicyPort struct {
	From  uint16 `json:"from"`
	To    uint16 `json:"to"`
	Range bool   `json:"-"`
}

var networkDomainPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func (spec networkPolicySpec) MarshalJSON() ([]byte, error) {
	switch spec.SchemaVersion {
	case 1:
		return json.Marshal(struct {
			SchemaVersion int    `json:"schema_version"`
			Action        string `json:"action"`
		}{SchemaVersion: 1, Action: spec.Action})
	case 2:
		rules := spec.Rules
		if rules == nil {
			rules = []networkPolicyRule{}
		}
		return json.Marshal(struct {
			SchemaVersion int                 `json:"schema_version"`
			Default       string              `json:"default"`
			Rules         []networkPolicyRule `json:"rules"`
		}{SchemaVersion: 2, Default: spec.Default, Rules: rules})
	default:
		return nil, fmt.Errorf("unsupported policy schema version")
	}
}

func (rule networkPolicyRule) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Action   string              `json:"action"`
		CIDRs    []string            `json:"cidrs,omitempty"`
		Domains  []string            `json:"domains,omitempty"`
		Ports    []networkPolicyPort `json:"ports,omitempty"`
		Protocol string              `json:"protocol,omitempty"`
	}{
		Action:   rule.Action,
		CIDRs:    rule.CIDRs,
		Domains:  rule.Domains,
		Ports:    rule.Ports,
		Protocol: rule.Protocol,
	})
}

func (port networkPolicyPort) MarshalJSON() ([]byte, error) {
	if !port.Range && port.From == port.To {
		return json.Marshal(port.From)
	}
	return json.Marshal(struct {
		From uint16 `json:"from"`
		To   uint16 `json:"to"`
	}{From: port.From, To: port.To})
}

func (spec *networkPolicySpec) UnmarshalJSON(raw []byte) error {
	var fields struct {
		SchemaVersion json.RawMessage `json:"schema_version"`
		Action        json.RawMessage `json:"action"`
		Default       json.RawMessage `json:"default"`
		Rules         json.RawMessage `json:"rules"`
	}
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return err
	}
	version, err := decodeSpecUint(fields.SchemaVersion, "schema_version")
	if err != nil {
		return err
	}
	switch version {
	case 1:
		if fields.Action == nil || fields.Default != nil || fields.Rules != nil {
			return fmt.Errorf("schema_version 1 carries action only")
		}
		action, err := decodeSpecString(fields.Action, "action")
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
		defaultAction, err := decodeSpecString(fields.Default, "default")
		if err != nil {
			return err
		}
		var rawRules []json.RawMessage
		if err := decodeSpecList(fields.Rules, &rawRules, "rules"); err != nil {
			return err
		}
		if len(rawRules) > 128 {
			return fmt.Errorf("policy rules exceed 128")
		}
		rules := make([]networkPolicyRule, 0, len(rawRules))
		for _, entry := range rawRules {
			rule, err := decodeSpecRule(entry)
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

func decodeSpecRule(raw json.RawMessage) (networkPolicyRule, error) {
	var fields struct {
		Action   json.RawMessage `json:"action"`
		CIDRs    json.RawMessage `json:"cidrs"`
		Domains  json.RawMessage `json:"domains"`
		Ports    json.RawMessage `json:"ports"`
		Protocol json.RawMessage `json:"protocol"`
	}
	var rule networkPolicyRule
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return rule, err
	}
	action, err := decodeSpecString(fields.Action, "action")
	if err != nil {
		return rule, err
	}
	rule.Action = action
	if err := decodeSpecStrings(fields.CIDRs, &rule.CIDRs, "cidrs"); err != nil {
		return rule, err
	}
	if err := decodeSpecStrings(fields.Domains, &rule.Domains, "domains"); err != nil {
		return rule, err
	}
	if len(rule.CIDRs) > 0 && len(rule.Domains) > 0 {
		return rule, fmt.Errorf("cidrs and domains are mutually exclusive")
	}
	if fields.Ports != nil {
		var rawPorts []json.RawMessage
		if err := decodeSpecList(fields.Ports, &rawPorts, "ports"); err != nil {
			return rule, err
		}
		for _, entry := range rawPorts {
			port, err := decodeSpecPort(entry)
			if err != nil {
				return rule, err
			}
			rule.Ports = append(rule.Ports, port)
		}
	}
	if fields.Protocol != nil {
		protocol, err := decodeSpecString(fields.Protocol, "protocol")
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

func decodeSpecPort(raw json.RawMessage) (networkPolicyPort, error) {
	var single uint64
	if err := json.Unmarshal(raw, &single); err == nil {
		if single > 65535 {
			return networkPolicyPort{}, fmt.Errorf("port out of range")
		}
		return networkPolicyPort{From: uint16(single), To: uint16(single), Range: false}, nil
	}
	var fields struct {
		From json.RawMessage `json:"from"`
		To   json.RawMessage `json:"to"`
	}
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return networkPolicyPort{}, err
	}
	from, err := decodeSpecUint(fields.From, "from")
	if err != nil {
		return networkPolicyPort{}, err
	}
	to, err := decodeSpecUint(fields.To, "to")
	if err != nil {
		return networkPolicyPort{}, err
	}
	if from > 65535 || to > 65535 {
		return networkPolicyPort{}, fmt.Errorf("port out of range")
	}
	return networkPolicyPort{From: uint16(from), To: uint16(to), Range: true}, nil
}

func decodeSpecUint(raw json.RawMessage, name string) (uint64, error) {
	if raw == nil || isSpecNull(raw) {
		return 0, fmt.Errorf("%s is required", name)
	}
	var value uint64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, fmt.Errorf("%s must be an unsigned integer", name)
	}
	return value, nil
}

func decodeSpecString(raw json.RawMessage, name string) (string, error) {
	if raw == nil || isSpecNull(raw) {
		return "", fmt.Errorf("%s is required", name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", name)
	}
	return value, nil
}

func decodeSpecList(raw json.RawMessage, target *[]json.RawMessage, name string) error {
	if raw == nil || isSpecNull(raw) {
		return fmt.Errorf("%s is required", name)
	}
	return json.Unmarshal(raw, target)
}

func decodeSpecStrings(raw json.RawMessage, target *[]string, name string) error {
	if raw == nil {
		return nil
	}
	if isSpecNull(raw) {
		return fmt.Errorf("%s must not be null", name)
	}
	return json.Unmarshal(raw, target)
}

func isSpecNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func (spec networkPolicySpec) Valid() bool {
	switch spec.SchemaVersion {
	case 1:
		return networkActionValid(spec.Action) &&
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

func (rule networkPolicyRule) valid() bool {
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
		if len(domain) > 253 || !networkDomainPattern.MatchString(domain) {
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

func (spec networkPolicySpec) Equal(other networkPolicySpec) bool {
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

func deriveNetworkPolicyID(organizationID, agentID string, spec networkPolicySpec) (string, error) {
	specJSON, err := json.Marshal(spec)
	if err != nil {
		return "", err
	}
	organizationJSON, err := json.Marshal(organizationID)
	if err != nil {
		return "", err
	}
	agentJSON, err := json.Marshal(agentID)
	if err != nil {
		return "", err
	}
	canonical := append([]byte{'['}, organizationJSON...)
	canonical = append(canonical, ',')
	canonical = append(canonical, agentJSON...)
	canonical = append(canonical, ',')
	canonical = append(canonical, specJSON...)
	canonical = append(canonical, ']')
	sum := sha256.Sum256(canonical)
	return "custom/" + hex.EncodeToString(sum[:]), nil
}
