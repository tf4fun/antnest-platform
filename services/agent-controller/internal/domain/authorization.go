package domain

import (
	"fmt"
	"regexp"
	"sort"
)

type AuthorizationMode string

const (
	AuthorizationAuto         AuthorizationMode = "auto"
	AuthorizationApprove      AuthorizationMode = "approve"
	AuthorizationSmartApprove AuthorizationMode = "smart_approve"
	AuthorizationChat         AuthorizationMode = "chat"
)

func (mode AuthorizationMode) Valid() bool {
	switch mode {
	case AuthorizationAuto, AuthorizationApprove, AuthorizationSmartApprove, AuthorizationChat:
		return true
	default:
		return false
	}
}

type ToolRule struct {
	Source   string `json:"source"`
	SourceID string `json:"source_id"`
	ToolName string `json:"tool_name"`
	Decision string `json:"decision"`
}

type Authorization struct {
	Mode      AuthorizationMode `json:"mode"`
	ToolRules []ToolRule        `json:"tool_rules"`
}

var configurationIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_./:-]{1,200}$`)

func (authorization Authorization) Validate() error {
	if !authorization.Mode.Valid() {
		return fmt.Errorf("invalid authorization mode")
	}
	return validateToolRules(authorization.ToolRules, 256)
}

func validateToolRules(rules []ToolRule, limit int) error {
	if len(rules) > limit {
		return fmt.Errorf("too many tool authorization rules")
	}
	seen := make(map[string]bool, len(rules))
	for _, rule := range rules {
		if (rule.Source != "runtime" && rule.Source != "agent") ||
			!configurationIdentifier.MatchString(rule.SourceID) || !configurationIdentifier.MatchString(rule.ToolName) ||
			(rule.Decision != "allow" && rule.Decision != "deny") || seen[rule.key()] {
			return fmt.Errorf("invalid or duplicate tool authorization rule")
		}
		seen[rule.key()] = true
	}
	return nil
}

func (rule ToolRule) key() string {
	return rule.Source + "\x00" + rule.SourceID + "\x00" + rule.ToolName
}

func NormalizeDefaultAuthorization(defaults Authorization) (Authorization, error) {
	if err := defaults.Validate(); err != nil {
		return Authorization{}, err
	}
	if len(defaults.ToolRules) > 128 {
		return Authorization{}, fmt.Errorf("too many default tool authorization rules")
	}
	result := Authorization{Mode: defaults.Mode, ToolRules: append([]ToolRule{}, defaults.ToolRules...)}
	sort.Slice(result.ToolRules, func(i, j int) bool { return result.ToolRules[i].key() < result.ToolRules[j].key() })
	return result, nil
}
