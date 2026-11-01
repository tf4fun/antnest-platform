package docker

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

const resourceNameMaxBytes = 128
const scopedResourceNameFormat = "antnest-%s-%s-%s"

func runtimeContainerName(scope, agentID string) string {
	return scopedResourceName(scope, "runtime", agentID)
}

func workspaceVolumeName(scope, agentID string) string {
	return scopedResourceName(scope, "workspace", agentID)
}

func scopedResourceName(scope, kind, agentID string) string {
	scopePart := scope
	if !plainNameSegment(scope) || ambiguousScope(scope) {
		scopePart = hashedNameSegment(scope)
	}
	agentPart := agentID
	if !plainNameSegment(agentID) {
		agentPart = hashedNameSegment(agentID)
	}
	name := fmt.Sprintf(scopedResourceNameFormat, scopePart, kind, agentPart)
	if len(name) > resourceNameMaxBytes {
		scopePart = hashedNameSegment(scope)
		name = fmt.Sprintf(scopedResourceNameFormat, scopePart, kind, agentPart)
		if len(name) > resourceNameMaxBytes {
			agentPart = hashedNameSegment(agentID)
			name = fmt.Sprintf(scopedResourceNameFormat, scopePart, kind, agentPart)
		}
	}
	return name
}

func plainNameSegment(value string) bool {
	if value == "" || strings.HasPrefix(value, "h-") {
		return false
	}
	for index, b := range []byte(value) {
		letter := b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
		digit := b >= '0' && b <= '9'
		if letter || digit || index > 0 && (b == '_' || b == '.' || b == '-') {
			continue
		}
		return false
	}
	return true
}

func ambiguousScope(scope string) bool {
	return scope == "runtime" || scope == "workspace" ||
		strings.HasPrefix(scope, "runtime-") || strings.HasPrefix(scope, "workspace-") ||
		strings.HasSuffix(scope, "-runtime") || strings.HasSuffix(scope, "-workspace") ||
		strings.Contains(scope, "-runtime-") || strings.Contains(scope, "-workspace-")
}

func hashedNameSegment(value string) string {
	sum := sha256.Sum256([]byte(value))
	return "h-" + hex.EncodeToString(sum[:16])
}

func managedRuntimeName(scope, name, agentID string) bool {
	return name == runtimeContainerName(scope, agentID) || name == containerName(agentID)
}
