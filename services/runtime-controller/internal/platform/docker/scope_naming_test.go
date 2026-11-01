package docker

import (
	"regexp"
	"strings"
	"testing"
)

var hashedSegmentPattern = regexp.MustCompile(`^h-[0-9a-f]{32}$`)

func TestScopedNamesUseExactScopeAgentLayout(t *testing.T) {
	if got := runtimeContainerName("rc", "agent-1"); got != "antnest-rc-runtime-agent-1" {
		t.Fatalf("scoped runtime name: %q", got)
	}
	if got := workspaceVolumeName("rc", "agent-1"); got != "antnest-rc-workspace-agent-1" {
		t.Fatalf("scoped workspace name: %q", got)
	}
	for _, name := range []string{
		runtimeContainerName("test-controller", "agent-1"),
		workspaceVolumeName("test-controller", "agent-1"),
	} {
		if len(name) > resourceNameMaxBytes {
			t.Fatalf("scoped name exceeds the limit: %q", name)
		}
	}
	if runtimeContainerName("rc", "agent-1") != runtimeContainerName("rc", "agent-1") {
		t.Fatal("scoped naming is not stable")
	}
	if runtimeContainerName("scope-a", "agent-1") == runtimeContainerName("scope-b", "agent-1") {
		t.Fatal("distinct scopes share one runtime name")
	}
	if runtimeContainerName("rc", "agent-1") == runtimeContainerName("rc", "agent-2") {
		t.Fatal("distinct Agents share one runtime name")
	}
	if runtimeContainerName("rc", "agent-1") == workspaceVolumeName("rc", "agent-1") {
		t.Fatal("runtime and workspace share one scoped name")
	}
}

func TestScopedNameBoundariesKeepPlainSegments(t *testing.T) {
	scope := strings.Repeat("s", 128-len("antnest-")-len("-runtime-")-len("agent-1"))
	if got := runtimeContainerName(scope, "agent-1"); len(got) != 128 {
		t.Fatalf("boundary name: %q (%d)", got, len(got))
	}
	if got := runtimeContainerName(scope+"s", "agent-1"); len(got) > 128 {
		t.Fatalf("overflow name was not bounded: %q (%d)", got, len(got))
	}
	if !strings.HasPrefix(runtimeContainerName(scope+"s", "agent-1"), "antnest-h-") {
		t.Fatalf("overflow scope was not hashed: %q", runtimeContainerName(scope+"s", "agent-1"))
	}
}

func TestScopedNamesHashAmbiguousOrInvalidSegments(t *testing.T) {
	for _, test := range []struct {
		name  string
		scope string
		agent string
	}{
		{"scope delimiter runtime", "east-runtime-wing", "agent-1"},
		{"scope delimiter workspace", "east-workspace-wing", "agent-1"},
		{"scope reserved prefix", "h-forged", "agent-1"},
		{"agent reserved prefix", "rc", "h-forged"},
		{"scope invalid bytes", "scope with spaces", "agent-1"},
		{"agent invalid bytes", "rc", "agent/one"},
		{"scope exact kind", "runtime", "agent-1"},
		{"scope kind suffix", "prod-runtime", "agent-1"},
		{"scope kind prefix", "workspace-east", "agent-1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := runtimeContainerName(test.scope, test.agent)
			if len(got) > resourceNameMaxBytes {
				t.Fatalf("hashed name exceeds the limit: %q (%d)", got, len(got))
			}
			if got == "antnest-"+test.scope+"-runtime-"+test.agent {
				t.Fatalf("ambiguous or invalid segment was preserved: %q", got)
			}
			if !strings.HasPrefix(got, "antnest-") {
				t.Fatalf("hashed name lost the managed prefix: %q", got)
			}
			for _, segment := range strings.Split(strings.TrimPrefix(got, "antnest-"), "-runtime-") {
				if hashedSegmentPattern.MatchString(segment) {
					return
				}
			}
			if segments := strings.Split(got, "-"); segments[len(segments)-1] != test.agent {
				t.Fatalf("name preserves neither a hash nor the plain Agent: %q", got)
			}
		})
	}
}

func TestHashedSegmentsAreDeterministicAndCollisionResistant(t *testing.T) {
	long := strings.Repeat("a", 110)
	first := runtimeContainerName("rc", long+"1")
	second := runtimeContainerName("rc", long+"2")
	if first == second {
		t.Fatalf("near-identical long Agents collide: %q", first)
	}
	if hashedNameSegment("scope") != hashedNameSegment("scope") {
		t.Fatal("segment hashing is not deterministic")
	}
	if !hashedSegmentPattern.MatchString(hashedNameSegment("scope")) {
		t.Fatalf("hashed segment is not the 128-bit form: %q", hashedNameSegment("scope"))
	}
}

func TestScopedNamesFitWhenBothSegmentsAreHuge(t *testing.T) {
	name := runtimeContainerName(strings.Repeat("s", 400), strings.Repeat("a", 400))
	if len(name) > resourceNameMaxBytes {
		t.Fatalf("double-huge name exceeds the limit: %q (%d)", name, len(name))
	}
	if !strings.Contains(name, "-runtime-h-") {
		t.Fatalf("huge Agent was not hashed last: %q", name)
	}
}
