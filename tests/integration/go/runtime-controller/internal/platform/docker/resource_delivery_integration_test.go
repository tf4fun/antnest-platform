package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type resourceDeliveryEntry struct {
	Name             string          `json:"name"`
	Configuration    json.RawMessage `json:"configuration"`
	TemplateResource json.RawMessage `json:"template_resources"`
}

var deniedResolverSyscalls = []string{"keyctl", "bpf", "perf_event_open", "userfaultfd", "mount"}

var exactRuntimeCaps = []string{"CHOWN", "DAC_OVERRIDE", "KILL", "NET_ADMIN", "SETGID", "SETPCAP", "SETUID"}

func TestRuntimeResourceDeliveryConsumer(t *testing.T) {
	input := os.Getenv("ANTNEST_RUNTIME_RESOURCE_INPUT")
	if input == "" {
		t.Skip("only run by the resource delivery contract bridge")
	}
	raw, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	var entries []resourceDeliveryEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 7 {
		t.Fatalf("expected seven producer entries, got %d", len(entries))
	}
	ctx := context.Background()
	for _, entry := range entries {
		var configuration deployment.Configuration
		if err := json.Unmarshal(entry.Configuration, &configuration); err != nil {
			t.Fatalf("%s: decode producer configuration: %v", entry.Name, err)
		}
		resolved, err := configuration.Resolve("agent-1", 7)
		if err != nil {
			t.Fatalf("%s: deployment validation: %v", entry.Name, err)
		}
		engine := newFakeEngine()
		driver := newTestDriver(t, engine)
		digest, err := driver.DeploymentDigest(resolved)
		if err != nil {
			t.Fatalf("%s: deployment digest: %v", entry.Name, err)
		}
		outcome := driver.Create(ctx, resolved, digest)
		if outcome.State != deployment.EffectCompleted {
			t.Fatalf("%s: create outcome %+v", entry.Name, outcome)
		}
		encoded, err := json.Marshal(dockerCreateRequest(engine.created))
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if err := json.Unmarshal(encoded, &body); err != nil {
			t.Fatal(err)
		}
		if body["StopTimeout"] != float64(RuntimeStopGraceSeconds) {
			t.Fatalf("%s: StopTimeout %v", entry.Name, body["StopTimeout"])
		}
		host, _ := body["HostConfig"].(map[string]any)
		if host["ReadonlyRootfs"] != true {
			t.Fatalf("%s: rootfs not read-only", entry.Name)
		}
		cpu := resolved.Resources.EffectiveCPUMillis()
		if host["NanoCpus"] != float64(cpu*1000000) ||
			host["CpuShares"] != float64(max(2, cpu*1024/1000)) {
			t.Fatalf("%s: cpu mapping lost at the wire: %v", entry.Name, host)
		}
		labels, _ := body["Labels"].(map[string]any)
		if labels["io.antnest.workspace-bytes"] != strconv.FormatUint(resolved.Resources.EffectiveWorkspaceBytes(), 10) {
			t.Fatalf("%s: workspace bytes label %v", entry.Name, labels)
		}
		tmpfs, _ := host["Tmpfs"].(map[string]any)
		wantTmp := fmt.Sprintf("rw,noexec,nosuid,nodev,size=%d", configuration.Resources.TmpfsBytes)
		if tmpfs["/tmp"] != wantTmp {
			t.Fatalf("%s: /tmp flags %v, want %q", entry.Name, tmpfs, wantTmp)
		}
		capDrop, _ := host["CapDrop"].([]any)
		if !slices.Contains(capDrop, "ALL") {
			t.Fatalf("%s: CapDrop missing ALL: %v", entry.Name, capDrop)
		}
		capAdd, _ := host["CapAdd"].([]any)
		gotCaps := make([]string, 0, len(capAdd))
		for _, cap := range capAdd {
			gotCaps = append(gotCaps, fmt.Sprint(cap))
		}
		slices.Sort(gotCaps)
		if !slices.Equal(gotCaps, slices.Sorted(slices.Values(exactRuntimeCaps))) {
			t.Fatalf("%s: CapAdd %v", entry.Name, gotCaps)
		}
		mounts, _ := host["Mounts"].([]any)
		workspaceFound, resolverFound := false, false
		for _, rawMount := range mounts {
			mount, _ := rawMount.(map[string]any)
			if mount["Target"] == "/workspace" {
				workspaceFound = mount["Type"] == "volume" && mount["Source"] == "antnest-workspace-agent-1"
			}
			if mount["Target"] == "/etc/resolv.conf" {
				options, _ := mount["VolumeOptions"].(map[string]any)
				resolverFound = mount["ReadOnly"] == true && options["Subpath"] == "resolv.conf"
			}
		}
		if !workspaceFound || !resolverFound {
			t.Fatalf("%s: mounts workspace=%t resolver=%t: %v", entry.Name, workspaceFound, resolverFound, mounts)
		}
		security, _ := host["SecurityOpt"].([]any)
		nnpFound, profileFound := false, false
		for _, option := range security {
			text := fmt.Sprint(option)
			if text == "no-new-privileges=true" {
				nnpFound = true
			}
			if rest, ok := strings.CutPrefix(text, "seccomp="); ok {
				profileFound = true
				var profile map[string]any
				if err := json.Unmarshal([]byte(rest), &profile); err != nil {
					t.Fatalf("%s: seccomp profile not JSON: %v", entry.Name, err)
				}
				if profile["defaultAction"] != "SCMP_ACT_ERRNO" {
					t.Fatalf("%s: seccomp not deny-default: %v", entry.Name, profile["defaultAction"])
				}
				rules, _ := profile["syscalls"].([]any)
				for _, rawRule := range rules {
					rule, _ := rawRule.(map[string]any)
					if rule["action"] != "SCMP_ACT_ALLOW" {
						continue
					}
					names, _ := rule["names"].([]any)
					for _, name := range names {
						if slices.Contains(deniedResolverSyscalls, fmt.Sprint(name)) {
							t.Fatalf("%s: forbidden syscall %v allowed", entry.Name, name)
						}
					}
				}
			}
		}
		if !nnpFound || !profileFound {
			t.Fatalf("%s: SecurityOpt nnp=%t seccomp=%t: %v", entry.Name, nnpFound, profileFound, security)
		}
		if driver.DiskQuotaEnforced() {
			t.Fatalf("%s: default local backend must stay unbounded", entry.Name)
		}
	}
	t.Logf("ANTNEST_RUNTIME_RESOURCE_CONSUMER=7")
}
