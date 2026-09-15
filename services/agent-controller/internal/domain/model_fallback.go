package domain

import (
	"fmt"
	"strings"
)

// A model reference also identifies its connection; no parallel Provider ID list
// is stored that could disagree with the selected models.
func ValidateModelFallback(primary string, fallback []string) error {
	if len(fallback) > 31 {
		return fmt.Errorf("at most 32 Provider candidates are allowed")
	}
	seen := map[string]bool{primary: true}
	for _, id := range fallback {
		if id == "" || strings.TrimSpace(id) != id || seen[id] {
			return fmt.Errorf("fallback model references must be nonempty and distinct")
		}
		seen[id] = true
	}
	return nil
}
