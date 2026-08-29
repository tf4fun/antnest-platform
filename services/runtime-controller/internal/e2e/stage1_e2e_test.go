package e2e_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

const runtimeImage = "antnest/antnest-runtime:local"

type harness struct {
	t      *testing.T
	client *http.Client
	base   string
	agent  string
	work   runtimecontracts.WorkRef
	purged bool
}

type runtimeView struct {
	AgentID            string `json:"agent_id"`
	NetworkMode        string `json:"network_mode"`
	DesiredState       string `json:"desired_state"`
	Status             string `json:"status"`
	DesiredGeneration  uint64 `json:"desired_generation"`
	ObservedGeneration uint64 `json:"observed_generation"`
}

type operationView struct {
	OperationID string `json:"operation_id"`
	Status      string `json:"status"`
	Generation  uint64 `json:"generation"`
}

func TestStage1RuntimeLifecycle(t *testing.T) {
	if os.Getenv("ANTNEST_STAGE1_E2E") != "1" {
		t.Skip("set ANTNEST_STAGE1_E2E=1 against a local Compose instance")
	}
	h := &harness{
		t: t, client: &http.Client{Timeout: 12 * time.Second},
		base:  valueOr("ANTNEST_STAGE1_BASE_URL", "http://127.0.0.1:8080"),
		agent: fmt.Sprintf("stage1-e2e-%d", time.Now().UnixNano()),
	}
	t.Cleanup(h.forceCleanup)
	h.requireServiceBoundaries()

	prepare := h.prepare("prepare-initial", "restricted")
	ready := h.waitRuntime("active", "ready", 30*time.Second)
	if ready.DesiredGeneration != 1 || ready.ObservedGeneration != 1 {
		t.Fatalf("initial generation did not converge: %+v", ready)
	}
	h.waitOperation(prepare.OperationID, "succeeded", 30*time.Second)
	replay := h.prepare("prepare-initial", "restricted")
	if replay.OperationID != prepare.OperationID || replay.Generation != prepare.Generation {
		t.Fatalf("Prepare replay changed operation: first=%+v replay=%+v", prepare, replay)
	}
	h.requireDockerResources(true, true)

	h.beginWork("run-initial", 1, "run")
	h.writeFile("write-notes", "notes.txt", []byte("stage-one"))
	edit := h.editFile("edit-notes", "notes.txt", "one", "two")
	if edit.Outcome.Disposition != runtimecontracts.EffectCompleted || edit.Outcome.Reason != "edited" {
		t.Fatalf("file edit failed: %+v", edit)
	}
	read := h.readFile("read-notes", "notes.txt")
	if string(read.Content) != "stage-two" {
		t.Fatalf("edited content = %q", read.Content)
	}
	listed := h.listDir("list-workspace", ".")
	if !containsEntry(listed.Entries, "notes.txt") {
		t.Fatalf("workspace listing omitted notes.txt: %+v", listed.Entries)
	}
	identity := h.exec("exec-identity", []string{
		"/bin/sh", "-lc", "id -u; printf '%s\\n' \"$HOME\"; cat notes.txt",
	}, 5*time.Second)
	if identity.ExitCode == nil || *identity.ExitCode != 0 || string(identity.Stdout) != "1000\n/workspace\nstage-two" {
		t.Fatalf("Runtime process identity drifted: %+v stdout=%q", identity, identity.Stdout)
	}
	blockedAt := time.Now()
	blocked := h.fixedIPRequest("network-blocked")
	if blocked.ExitCode == nil || *blocked.ExitCode == 0 || time.Since(blockedAt) > 8*time.Second {
		t.Fatalf("restricted network did not fail quickly: %+v", blocked)
	}
	h.endWork()

	unrestricted := h.updateNetwork("network-unrestricted", "unrestricted")
	ready = h.waitRuntime("active", "ready", 30*time.Second)
	if ready.NetworkMode != "unrestricted" || ready.DesiredGeneration != unrestricted.Generation {
		t.Fatalf("unrestricted generation did not converge: operation=%+v runtime=%+v", unrestricted, ready)
	}
	h.waitOperation(unrestricted.OperationID, "succeeded", 30*time.Second)
	h.beginWork("run-unrestricted", 2, "run")
	allowed := h.fixedIPRequest("network-allowed")
	if allowed.ExitCode == nil || *allowed.ExitCode != 0 {
		t.Fatalf("unrestricted fixed-IP request failed: %+v stderr=%q", allowed, allowed.Stderr)
	}
	h.waitDNS("dns-allowed", 10*time.Second)
	h.endWork()

	h.restartContainer(valueOr("ANTNEST_STAGE1_EGRESS_CONTAINER", "antnest-platform-runtime-egress-1"))
	h.waitContainerHealthy(valueOr("ANTNEST_STAGE1_EGRESS_CONTAINER", "antnest-platform-runtime-egress-1"), 30*time.Second)
	h.waitReady(30 * time.Second)
	h.beginWorkEventually("run-after-egress-restart", 3, "run", 30*time.Second)
	firstPacket := h.fixedIPRequest("first-packet-after-egress-restart")
	if firstPacket.ExitCode == nil || *firstPacket.ExitCode != 0 {
		t.Fatalf("first packet after Egress restart failed: %+v stderr=%q", firstPacket, firstPacket.Stderr)
	}
	h.endWork()

	restartGeneration := ready.DesiredGeneration
	h.restartContainer(valueOr("ANTNEST_STAGE1_CONTROLLER_CONTAINER", "antnest-platform-runtime-controller-1"))
	h.waitContainerHealthy(valueOr("ANTNEST_STAGE1_CONTROLLER_CONTAINER", "antnest-platform-runtime-controller-1"), 30*time.Second)
	h.waitReady(30 * time.Second)
	recovered := h.waitRuntime("active", "ready", 30*time.Second)
	if recovered.DesiredGeneration != restartGeneration || recovered.ObservedGeneration != restartGeneration {
		h.t.Fatalf("Controller restart changed generation: before=%d after=%+v", restartGeneration, recovered)
	}
	h.requireDockerResources(true, true)
	h.beginWorkEventually("run-after-controller-restart", 4, "run", 30*time.Second)
	firstPacket = h.fixedIPRequest("first-packet-after-controller-restart")
	if firstPacket.ExitCode == nil || *firstPacket.ExitCode != 0 {
		t.Fatalf("first packet after Controller restart failed: %+v stderr=%q", firstPacket, firstPacket.Stderr)
	}
	h.writeFile("write-before-runtime-restart", "restart.txt", []byte("restart-once"))

	h.restartContainer("antnest-runtime-" + h.agent)
	recovered = h.waitRuntime("active", "ready", 30*time.Second)
	if recovered.DesiredGeneration != restartGeneration || recovered.ObservedGeneration != restartGeneration {
		h.t.Fatalf("Runtime restart changed generation: before=%d after=%+v", restartGeneration, recovered)
	}
	h.requireDockerResources(true, true)
	replayed := h.waitBeginWorkResult("run-after-controller-restart", 4, "run", 30*time.Second)
	if replayed.Disposition != runtimecontracts.EffectNotStarted || replayed.Reason != "stale_work" {
		t.Fatalf("Runtime restart accepted stale Work: %+v", replayed)
	}
	h.beginWork("run-after-runtime-restart", 5, "run")
	if content := h.readFile("read-after-runtime-restart", "restart.txt").Content; string(content) != "restart-once" {
		t.Fatalf("Runtime restart changed side effect: %q", content)
	}
	h.endWork()

	h.restartContainer(valueOr("ANTNEST_STAGE1_PROVIDER_CONTAINER", "antnest-platform-runtime-provider-docker-1"))
	h.waitContainerHealthy(valueOr("ANTNEST_STAGE1_PROVIDER_CONTAINER", "antnest-platform-runtime-provider-docker-1"), 30*time.Second)
	h.waitReady(30 * time.Second)

	restricted := h.updateNetwork("network-restricted", "restricted")
	ready = h.waitRuntime("active", "ready", 30*time.Second)
	if ready.NetworkMode != "restricted" || ready.DesiredGeneration != restricted.Generation {
		t.Fatalf("restricted generation did not converge: operation=%+v runtime=%+v", restricted, ready)
	}
	h.waitOperation(restricted.OperationID, "succeeded", 30*time.Second)
	h.beginWork("run-restricted-again", 6, "run")
	if result := h.fixedIPRequest("network-blocked-again"); result.ExitCode == nil || *result.ExitCode == 0 {
		t.Fatalf("restored restricted mode allowed network: %+v", result)
	}
	h.endWork()

	stoppedGeneration := ready.DesiredGeneration
	stopped := h.lifecycle(http.MethodPost, "/stop", "stop-runtime")
	h.waitRuntime("stopped", "stopped", 30*time.Second)
	h.waitOperation(stopped.OperationID, "succeeded", 30*time.Second)
	h.requireDockerResources(true, true)
	resumed := h.prepare("prepare-after-stop", "restricted")
	ready = h.waitRuntime("active", "ready", 30*time.Second)
	if resumed.Generation != stoppedGeneration || ready.DesiredGeneration != stoppedGeneration {
		t.Fatalf("Prepare after Stop replaced generation: operation=%+v runtime=%+v", resumed, ready)
	}
	h.waitOperation(resumed.OperationID, "succeeded", 30*time.Second)

	retired := h.lifecycle(http.MethodDelete, "", "retire-runtime")
	h.waitRuntime("retired", "retired", 30*time.Second)
	h.waitOperation(retired.OperationID, "succeeded", 30*time.Second)
	h.requireDockerResources(false, true)
	recreated := h.prepare("prepare-after-retire", "restricted")
	ready = h.waitRuntime("active", "ready", 30*time.Second)
	if recreated.Generation != stoppedGeneration+1 || ready.DesiredGeneration != stoppedGeneration+1 {
		t.Fatalf("Prepare after Retire did not create one generation: operation=%+v runtime=%+v", recreated, ready)
	}
	h.waitOperation(recreated.OperationID, "succeeded", 30*time.Second)

	purged := h.lifecycle(http.MethodPost, "/purge", "purge-runtime")
	h.waitRuntime("purged", "purged", 30*time.Second)
	h.waitOperation(purged.OperationID, "succeeded", 30*time.Second)
	h.requireDockerResources(false, false)
	h.purged = true
}

func (h *harness) prepare(key, mode string) operationView {
	return doJSON[operationView](h, http.MethodPut, "/internal/v1/runtimes/"+h.agent,
		map[string]any{"image_ref": runtimeImage, "network_mode": mode}, map[string]string{"Idempotency-Key": key})
}

func (h *harness) updateNetwork(key, mode string) operationView {
	return doJSON[operationView](h, http.MethodPut,
		"/internal/v1/runtimes/"+h.agent+"/network-policy",
		map[string]any{"mode": mode}, map[string]string{"Idempotency-Key": key})
}

func (h *harness) lifecycle(method, suffix, key string) operationView {
	return doJSON[operationView](h, method, "/internal/v1/runtimes/"+h.agent+suffix,
		nil, map[string]string{"Idempotency-Key": key})
}

func (h *harness) beginWork(workID string, epoch uint64, kind string) {
	result := h.beginWorkResult(workID, epoch, kind)
	if result.Disposition != runtimecontracts.EffectCompleted || !result.Accepted {
		h.t.Fatalf("begin Work failed: %+v", result)
	}
}

func (h *harness) beginWorkEventually(workID string, epoch uint64, kind string, timeout time.Duration) {
	h.t.Helper()
	result := h.waitBeginWorkResult(workID, epoch, kind, timeout)
	if result.Disposition != runtimecontracts.EffectCompleted || !result.Accepted {
		h.t.Fatalf("begin Work did not recover: %+v", result)
	}
}

func (h *harness) beginWorkResult(
	workID string, epoch uint64, kind string,
) runtimecontracts.BeginWorkResult {
	h.work = runtimecontracts.WorkRef{
		WorkID: workID, WorkEpoch: epoch, WorkSessionID: "session-" + workID,
	}
	return doJSON[runtimecontracts.BeginWorkResult](h, http.MethodPost,
		"/internal/v1/runtimes/"+h.agent+"/work:begin",
		map[string]any{
			"work_id": h.work.WorkID, "work_epoch": h.work.WorkEpoch,
			"work_session_id": h.work.WorkSessionID, "kind": kind,
		}, nil)
}

func (h *harness) waitBeginWorkResult(
	workID string, epoch uint64, kind string, timeout time.Duration,
) runtimecontracts.BeginWorkResult {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		h.work = runtimecontracts.WorkRef{
			WorkID: workID, WorkEpoch: epoch, WorkSessionID: "session-" + workID,
		}
		result, err := requestJSON[runtimecontracts.BeginWorkResult](h, http.MethodPost,
			"/internal/v1/runtimes/"+h.agent+"/work:begin",
			map[string]any{
				"work_id": h.work.WorkID, "work_epoch": h.work.WorkEpoch,
				"work_session_id": h.work.WorkSessionID, "kind": kind,
			}, nil)
		if err == nil && result.Reason != "runtime_unavailable" {
			return result
		}
		if err != nil && !strings.Contains(err.Error(), "409 Conflict") {
			h.t.Fatal(err)
		}
		time.Sleep(200 * time.Millisecond)
	}
	h.t.Fatal("Runtime did not reconnect before Work admission deadline")
	return runtimecontracts.BeginWorkResult{}
}

func (h *harness) endWork() {
	result := doJSON[runtimecontracts.EndWorkResult](h, http.MethodPost,
		"/internal/v1/runtimes/"+h.agent+"/work:end", h.work, nil)
	if !result.Closed {
		h.t.Fatalf("end Work failed: %+v", result)
	}
}

func (h *harness) writeFile(operationID, path string, content []byte) runtimecontracts.WriteFileResult {
	arguments := map[string]any{
		"path": map[string]any{"root": "workspace", "path": path}, "content": content,
	}
	return doJSON[runtimecontracts.WriteFileResult](h, http.MethodPost,
		"/internal/v1/runtimes/"+h.agent+"/files:write",
		h.operation("write_file", operationID, arguments), nil)
}

func (h *harness) editFile(
	operationID, path, oldString, newString string,
) runtimecontracts.EditFileResult {
	arguments := map[string]any{
		"path":       map[string]any{"root": "workspace", "path": path},
		"old_string": oldString, "new_string": newString,
	}
	return doJSON[runtimecontracts.EditFileResult](h, http.MethodPost,
		"/internal/v1/runtimes/"+h.agent+"/files:edit",
		h.operation("edit_file", operationID, arguments), nil)
}

func (h *harness) readFile(operationID, path string) runtimecontracts.ReadFileResult {
	arguments := map[string]any{
		"path": map[string]any{"root": "workspace", "path": path}, "offset": 0, "limit": 1024,
	}
	return doJSON[runtimecontracts.ReadFileResult](h, http.MethodPost,
		"/internal/v1/runtimes/"+h.agent+"/files:read",
		h.operation("read_file", operationID, arguments), nil)
}

func (h *harness) listDir(operationID, path string) runtimecontracts.ListDirResult {
	arguments := map[string]any{
		"path": map[string]any{"root": "workspace", "path": path}, "limit": 100,
	}
	return doJSON[runtimecontracts.ListDirResult](h, http.MethodPost,
		"/internal/v1/runtimes/"+h.agent+"/files:list",
		h.operation("list_dir", operationID, arguments), nil)
}

func (h *harness) exec(
	operationID string, argv []string, timeout time.Duration,
) runtimecontracts.ExecResult {
	arguments := map[string]any{
		"argv": argv, "working_dir": map[string]any{"root": "workspace", "path": "."},
		"env": []any{}, "timeout_ms": timeout.Milliseconds(),
	}
	return doJSON[runtimecontracts.ExecResult](h, http.MethodPost,
		"/internal/v1/runtimes/"+h.agent+"/process:exec",
		h.operation("exec", operationID, arguments), nil)
}

func (h *harness) fixedIPRequest(operationID string) runtimecontracts.ExecResult {
	return h.exec(operationID, []string{
		"curl", "--silent", "--show-error", "--max-time", "5", "http://1.1.1.1",
	}, 7*time.Second)
}

func (h *harness) waitDNS(operationID string, timeout time.Duration) runtimecontracts.ExecResult {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	var result runtimecontracts.ExecResult
	for attempt := 1; time.Now().Before(deadline); attempt++ {
		result = h.exec(fmt.Sprintf("%s-%d", operationID, attempt), []string{
			"python", "-c", "import socket; print(socket.gethostbyname('example.com'))",
		}, 5*time.Second)
		if result.ExitCode != nil && *result.ExitCode == 0 && strings.TrimSpace(string(result.Stdout)) != "" {
			return result
		}
		time.Sleep(250 * time.Millisecond)
	}
	h.t.Fatalf("unrestricted DNS lookup did not converge: %+v stderr=%q", result, result.Stderr)
	return runtimecontracts.ExecResult{}
}

func (h *harness) operation(method, operationID string, arguments map[string]any) map[string]any {
	result := make(map[string]any, len(arguments)+5)
	for key, value := range arguments {
		result[key] = value
	}
	result["work_id"] = h.work.WorkID
	result["work_epoch"] = h.work.WorkEpoch
	result["work_session_id"] = h.work.WorkSessionID
	result["operation_id"] = operationID
	result["request_digest"] = operationDigest(h.t, method, arguments)
	return result
}

func operationDigest(t *testing.T, method string, arguments map[string]any) string {
	t.Helper()
	methodJSON, err := json.Marshal(method)
	if err != nil {
		t.Fatal(err)
	}
	argumentsJSON, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(fmt.Appendf(nil, "{\"method\":%s,\"arguments\":%s}", methodJSON, argumentsJSON))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func (h *harness) waitRuntime(desiredState, status string, timeout time.Duration) runtimeView {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	var current runtimeView
	for time.Now().Before(deadline) {
		current = doJSON[runtimeView](h, http.MethodGet, "/internal/v1/runtimes/"+h.agent, nil, nil)
		if current.DesiredState == desiredState && current.Status == status &&
			(status != "ready" || current.DesiredGeneration == current.ObservedGeneration) {
			return current
		}
		time.Sleep(200 * time.Millisecond)
	}
	h.t.Fatalf("Runtime did not reach %s/%s: %+v", desiredState, status, current)
	return runtimeView{}
}

func (h *harness) waitOperation(operationID, status string, timeout time.Duration) operationView {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	var current operationView
	for time.Now().Before(deadline) {
		current = doJSON[operationView](h, http.MethodGet,
			"/internal/v1/runtime-operations/"+operationID, nil, nil)
		if current.Status == status {
			return current
		}
		if current.Status == "failed" || current.Status == "superseded" {
			h.t.Fatalf("operation %s terminated as %s", operationID, current.Status)
		}
		time.Sleep(200 * time.Millisecond)
	}
	h.t.Fatalf("operation %s did not reach %s: %+v", operationID, status, current)
	return operationView{}
}

func (h *harness) waitReady(timeout time.Duration) {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, h.base+"/readyz", nil)
		if err != nil {
			h.t.Fatal(err)
		}
		response, err := h.client.Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	h.t.Fatal("Runtime Controller did not become ready")
}

func (h *harness) restartContainer(name string) {
	h.t.Helper()
	command := exec.Command("docker", "restart", name)
	if output, err := command.CombinedOutput(); err != nil {
		h.t.Fatalf("restart %s: %v: %s", name, err, output)
	}
}

func (h *harness) waitContainerHealthy(name string, timeout time.Duration) {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		output, err := exec.Command("docker", "inspect", "--format", "{{.State.Health.Status}}", name).CombinedOutput()
		if err == nil && strings.TrimSpace(string(output)) == "healthy" {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	h.t.Fatalf("container %s did not become healthy", name)
}

func (h *harness) requireServiceBoundaries() {
	h.t.Helper()
	controller := h.inspectContainer(valueOr(
		"ANTNEST_STAGE1_CONTROLLER_CONTAINER", "antnest-platform-runtime-controller-1",
	))
	egress := h.inspectContainer(valueOr(
		"ANTNEST_STAGE1_EGRESS_CONTAINER", "antnest-platform-runtime-egress-1",
	))
	provider := h.inspectContainer(valueOr(
		"ANTNEST_STAGE1_PROVIDER_CONTAINER", "antnest-platform-runtime-provider-docker-1",
	))
	if controller.hasMount("/var/run/docker.sock") || controller.hasCapability("NET_ADMIN") ||
		controller.hasDevice("/dev/net/tun") {
		h.t.Fatalf("Controller retained host privilege: %+v", controller)
	}
	if !egress.hasCapability("NET_ADMIN") || !egress.hasDevice("/dev/net/tun") ||
		egress.hasMount("/var/run/docker.sock") {
		h.t.Fatalf("Egress privilege boundary is invalid: %+v", egress)
	}
	if !provider.hasMount("/var/run/docker.sock") || provider.hasCapability("NET_ADMIN") ||
		provider.hasDevice("/dev/net/tun") {
		h.t.Fatalf("Docker Provider privilege boundary is invalid: %+v", provider)
	}
}

type containerInspect struct {
	HostConfig struct {
		CapAdd  []string `json:"CapAdd"`
		Devices []struct {
			PathOnHost      string `json:"PathOnHost"`
			PathInContainer string `json:"PathInContainer"`
		} `json:"Devices"`
	} `json:"HostConfig"`
	Mounts []struct {
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
}

func (h *harness) inspectContainer(name string) containerInspect {
	h.t.Helper()
	output, err := exec.Command("docker", "inspect", name).CombinedOutput()
	if err != nil {
		h.t.Fatalf("inspect container %s: %v: %s", name, err, output)
	}
	var records []containerInspect
	if err := json.Unmarshal(output, &records); err != nil || len(records) != 1 {
		h.t.Fatalf("decode container %s inspection: %v", name, err)
	}
	return records[0]
}

func (c containerInspect) hasCapability(want string) bool {
	want = strings.TrimPrefix(strings.ToUpper(want), "CAP_")
	for _, capability := range c.HostConfig.CapAdd {
		if strings.TrimPrefix(strings.ToUpper(capability), "CAP_") == want {
			return true
		}
	}
	return false
}

func (c containerInspect) hasDevice(want string) bool {
	for _, device := range c.HostConfig.Devices {
		if device.PathOnHost == want || device.PathInContainer == want {
			return true
		}
	}
	return false
}

func (c containerInspect) hasMount(want string) bool {
	for _, mount := range c.Mounts {
		if mount.Source == want || mount.Destination == want {
			return true
		}
	}
	return false
}

func (h *harness) requireDockerResources(container, volume bool) {
	h.t.Helper()
	containerOutput, err := exec.Command(
		"docker", "ps", "-aq", "--filter", "label=io.antnest.agent-id="+h.agent,
	).CombinedOutput()
	if err != nil {
		h.t.Fatalf("inspect Runtime container: %v: %s", err, containerOutput)
	}
	hasContainer := strings.TrimSpace(string(containerOutput)) != ""
	containerCount := len(strings.Fields(string(containerOutput)))
	wantContainerCount := 0
	if container {
		wantContainerCount = 1
	}
	if hasContainer != container || containerCount != wantContainerCount {
		h.t.Fatalf("container count=%d want=%d output=%q", containerCount, wantContainerCount, containerOutput)
	}
	volumeName := "antnest-workspace-" + h.agent
	volumeErr := exec.Command("docker", "volume", "inspect", volumeName).Run()
	hasVolume := volumeErr == nil
	if hasVolume != volume {
		h.t.Fatalf("volume exists=%t want=%t err=%v", hasVolume, volume, volumeErr)
	}
}

func (h *harness) forceCleanup() {
	if !h.purged {
		_, _ = requestJSON[operationView](h, http.MethodPost,
			"/internal/v1/runtimes/"+h.agent+"/purge", nil,
			map[string]string{"Idempotency-Key": "cleanup-purge"})
	}
	_ = exec.Command("docker", "rm", "-f", "antnest-runtime-"+h.agent).Run()
	_ = exec.Command("docker", "volume", "rm", "antnest-workspace-"+h.agent).Run()
}

func doJSON[Output any](
	h *harness, method, path string, input any, headers map[string]string,
) Output {
	h.t.Helper()
	result, err := requestJSON[Output](h, method, path, input, headers)
	if err != nil {
		h.t.Fatal(err)
	}
	return result
}

func requestJSON[Output any](
	h *harness, method, path string, input any, headers map[string]string,
) (Output, error) {
	var result Output
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return result, err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(context.Background(), method, h.base+path, body)
	if err != nil {
		return result, err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := h.client.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return result, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, fmt.Errorf("%s %s returned %s: %s", method, path, response.Status, encoded)
	}
	if err := json.Unmarshal(encoded, &result); err != nil {
		return result, fmt.Errorf("decode %s %s: %w: %s", method, path, err, encoded)
	}
	return result, nil
}

func containsEntry(entries []runtimecontracts.DirectoryEntry, name string) bool {
	for _, entry := range entries {
		if entry.Name == name {
			return true
		}
	}
	return false
}

func valueOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
