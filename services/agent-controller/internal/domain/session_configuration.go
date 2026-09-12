package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

type SessionConfigurationOverrides struct {
	ModelProfileID    *string            `json:"model_profile_id,omitempty"`
	AuthorizationMode *AuthorizationMode `json:"authorization_mode,omitempty"`
	ToolRules         []ToolRule         `json:"tool_rules,omitempty"`
}

var configurationIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_./:-]{1,200}$`)

func (input SessionConfigurationOverrides) Validate() error {
	if input.ModelProfileID != nil && !configurationIdentifier.MatchString(*input.ModelProfileID) {
		return fmt.Errorf("invalid model profile selection")
	}
	if input.AuthorizationMode != nil && !input.AuthorizationMode.Valid() {
		return fmt.Errorf("invalid authorization mode")
	}
	return validateToolRules(input.ToolRules, 128)
}

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

func ResolveAuthorization(defaults Authorization, overrides SessionConfigurationOverrides) (Authorization, error) {
	if err := defaults.Validate(); err != nil {
		return Authorization{}, err
	}
	if len(defaults.ToolRules) > 128 {
		return Authorization{}, fmt.Errorf("too many default tool authorization rules")
	}
	if err := overrides.Validate(); err != nil {
		return Authorization{}, err
	}
	result := Authorization{Mode: defaults.Mode, ToolRules: make([]ToolRule, 0)}
	if overrides.AuthorizationMode != nil {
		result.Mode = *overrides.AuthorizationMode
	}
	rules := make(map[string]ToolRule, len(defaults.ToolRules)+len(overrides.ToolRules))
	for _, rule := range defaults.ToolRules {
		rules[rule.key()] = rule
	}
	for _, rule := range overrides.ToolRules {
		rules[rule.key()] = rule
	}
	for _, rule := range rules {
		result.ToolRules = append(result.ToolRules, rule)
	}
	sort.Slice(result.ToolRules, func(i, j int) bool { return result.ToolRules[i].key() < result.ToolRules[j].key() })
	return result, nil
}

func ExecutionConfigurationDigest(model ModelProfileRevisionSnapshot, authorization Authorization) (string, error) {
	payload, err := json.Marshal(struct {
		Version       int                          `json:"version"`
		Model         ModelProfileRevisionSnapshot `json:"model"`
		Authorization Authorization                `json:"authorization"`
	}{Version: 1, Model: model, Authorization: authorization})
	if err != nil {
		return "", fmt.Errorf("encode execution configuration: %w", err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}
