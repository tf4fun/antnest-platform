package runtimeprotocol

import (
	"fmt"
	"strings"
)

// GenerationKey is the stable identity shared by Runtime control, sessions,
// commands, and the egress tunnel.
type GenerationKey struct {
	RuntimeInstanceID string
	Generation        uint64
}

func (k GenerationKey) Validate() error {
	if strings.TrimSpace(k.RuntimeInstanceID) == "" {
		return fmt.Errorf("runtime instance id is required")
	}
	if k.Generation == 0 {
		return fmt.Errorf("runtime generation must be positive")
	}
	return nil
}
