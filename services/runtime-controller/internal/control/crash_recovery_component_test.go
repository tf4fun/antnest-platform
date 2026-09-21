package control_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/platform"
	dockerplatform "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
	repositoryport "soft/antnest-platform/services/runtime-controller/internal/repository"
	"soft/antnest-platform/services/runtime-controller/internal/repository/postgres"
)

const crashExit = 86
const crashLabel = "io.antnest.runtime-controller-scope"

type crashJob struct {
	Database, Socket, Scope, Network, Skills, Agent, Phase, Events string
	Configuration                                                  deployment.Configuration
	Source                                                         deployment.RuntimeRevision
}

type crashReady struct{}

func (crashReady) ObservationReady() error { return nil }

type crashVerifier struct{}

func (crashVerifier) Verify(context.Context, deployment.Inspection) (deployment.Inspection, error) {
	return deployment.Inspection{}, errors.New("Update provisioning must not depend on Runtime readiness")
}

type crashEngine struct {
	dockerplatform.Engine
	events string
}

func (e crashEngine) record(kind, id string) {
	f, err := os.OpenFile(e.events, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		panic("cannot record physical effect")
	}
	defer func() { _ = f.Close() }()
	if _, err := fmt.Fprintln(f, kind, id); err != nil {
		panic("cannot record physical effect")
	}
	if err := f.Sync(); err != nil {
		panic("cannot persist physical effect")
	}
}
func (e crashEngine) CreateContainer(ctx context.Context, spec dockerplatform.ContainerSpec) (string, error) {
	id, err := e.Engine.CreateContainer(ctx, spec)
	if err == nil {
		e.record("create", id)
	}
	return id, err
}
func (e crashEngine) RemoveContainer(ctx context.Context, id string) error {
	err := e.Engine.RemoveContainer(ctx, id)
	if err == nil {
		e.record("remove", id)
	}
	return err
}
func (e crashEngine) StopContainer(ctx context.Context, id string) error {
	err := e.Engine.StopContainer(ctx, id)
	if err == nil {
		e.record("stop", id)
	}
	return err
}

func (e crashEngine) StartContainer(ctx context.Context, id string) error {
	err := e.Engine.StartContainer(ctx, id)
	if err == nil {
		e.record("start", id)
	}
	return err
}

type crashPlatform struct {
	platform.Lifecycle
	phase string
}

func (p crashPlatform) Delete(ctx context.Context, key deployment.Key, digest string) deployment.EffectOutcome {
	if p.phase == "before-remove" {
		os.Exit(crashExit)
	}
	out := p.Lifecycle.Delete(ctx, key, digest)
	if p.phase == "after-remove" && out.State == deployment.EffectCompleted {
		os.Exit(crashExit)
	}
	return out
}
func (p crashPlatform) Create(ctx context.Context, value deployment.Deployment, digest string) deployment.EffectOutcome {
	out := p.Lifecycle.Create(ctx, value, digest)
	if p.phase == "after-create" && out.State == deployment.EffectCompleted {
		os.Exit(crashExit)
	}
	return out
}

type crashStore struct {
	repositoryport.Store
	phase string
}

func (s crashStore) CompleteOperation(ctx context.Context, operation deployment.Operation, event *deployment.Observation) (*deployment.Observation, error) {
	result, err := s.Store.CompleteOperation(ctx, operation, event)
	if err == nil && s.phase == "after-commit" && operation.Kind == deployment.OperationUpdateRuntime && operation.State == deployment.OperationCompleted {
		os.Exit(crashExit)
	}
	return result, err
}

func crashService(t *testing.T, ctx context.Context, job crashJob) (*control.Service, *postgres.Repository, *sql.DB) {
	t.Helper()
	db, err := postgres.OpenDatabase(ctx, job.Database, 8, 2)
	if err != nil {
		t.Fatal("open dedicated crash database failed")
	}
	t.Cleanup(func() { _ = db.Close() })
	locks, err := postgres.OpenDatabase(ctx, job.Database, 4, 1)
	if err != nil {
		t.Fatal("open dedicated lock database failed")
	}
	t.Cleanup(func() { _ = locks.Close() })
	repo, err := postgres.New(db, locks, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	engine, err := dockerplatform.NewUnixClient(job.Socket)
	if err != nil {
		t.Fatal(err)
	}
	driver, err := dockerplatform.NewDriver(crashEngine{engine, job.Events}, dockerplatform.Config{
		ControllerScope: job.Scope, ManagementNetwork: job.Network, SystemSkillsVolume: job.Skills,
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := control.NewService(crashStore{repo, job.Phase}, repo, crashReady{}, crashPlatform{driver, job.Phase}, crashVerifier{}, time.Now, 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return service, repo, db
}

// Only a separately invoked, disposable component run executes this process-loss suite.
func TestRuntimeUpdateProcessCrashRecovery(t *testing.T) {
	if os.Getenv("ANTNEST_RUNTIME_CONTROLLER_CRASH_TEST") != "true" {
		t.Skip("opt in with ANTNEST_RUNTIME_CONTROLLER_CRASH_TEST=true")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	job := newCrashFixture(t, ctx)
	for _, phase := range []string{"before-remove", "after-remove", "after-create", "after-commit"} {
		t.Run(phase, func(t *testing.T) { checkCrashRecovery(t, ctx, job, phase) })
		if ctx.Err() != nil {
			t.Fatal("crash fixture interrupted or timed out")
		}
	}
}

func TestRuntimeUpdateCrashChild(t *testing.T) {
	path := os.Getenv("ANTNEST_RUNTIME_CRASH_JOB")
	if path == "" {
		t.Skip("subprocess fixture only")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("cannot read private crash job")
	}
	var job crashJob
	if err := json.Unmarshal(data, &job); err != nil {
		t.Fatal("invalid crash job")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	service, _, _ := crashService(t, ctx, job)
	operation, err := service.UpdateRuntime(ctx, "update-"+job.Agent, job.Agent, job.Source, job.Configuration)
	if err != nil || operation.State != deployment.OperationCompleted {
		t.Fatalf("Update did not complete: state=%s code=%s error=%v", operation.State, operation.ErrorCode, err)
	}
	if job.Phase != "" {
		t.Fatal("requested crash checkpoint was not reached")
	}
}

func checkCrashRecovery(t *testing.T, ctx context.Context, job crashJob, phase string) {
	t.Helper()
	job.Agent = job.Scope + "-" + phase
	job.Events = filepath.Join(t.TempDir(), "effects")
	service, repo, db := crashService(t, ctx, job)
	source, err := service.InitializeRuntime(ctx, "init-"+job.Agent, job.Agent, job.Configuration)
	if err != nil || source.State != deployment.OperationCompleted {
		t.Fatalf("initialize failed: state=%s code=%s error=%v", source.State, source.ErrorCode, err)
	}
	job.Source = source.RuntimeRevision
	name, volume := "antnest-runtime-"+job.Agent, "antnest-workspace-"+job.Agent
	original := inspectCrashContainer(t, ctx, name)
	dockerCommand(t, ctx, "exec", name, "sh", "-c", "printf 'crash-recovery-sentinel\\n' > /workspace/.crash-sentinel")
	volumeBefore := dockerCommand(t, ctx, "volume", "inspect", volume)
	job.Phase = phase
	runCrashChild(t, ctx, job, crashExit)
	pending, err := repo.GetOperation(ctx, "update-"+job.Agent)
	if err != nil {
		t.Fatal(err)
	}
	expectedState := deployment.OperationRunning
	if phase == "after-commit" {
		expectedState = deployment.OperationCompleted
	}
	if pending.State != expectedState || pending.Attempt != 1 || pending.Generation != 2 || pending.SourceRevision != source.RuntimeRevision || pending.RuntimeRevision == source.RuntimeRevision {
		t.Fatalf("wrong durable checkpoint: state=%s attempt=%d generation=%d", pending.State, pending.Attempt, pending.Generation)
	}
	head, err := repo.GetEnvironment(ctx, job.Agent)
	if err != nil || head.RuntimeRevision != pending.RuntimeRevision {
		t.Fatal("checkpoint lost target binding")
	}
	if phase != "after-commit" && head.OperationID != pending.RequestID {
		t.Fatal("nonterminal mutation lost ownership")
	}
	assertCrashCounts(t, ctx, db, job.Agent, map[bool]int{true: 1, false: 0}[phase == "after-commit"])
	var targetBefore string
	switch phase {
	case "before-remove":
		if inspectCrashContainer(t, ctx, name).ID != original.ID {
			t.Fatal("source removed before checkpoint")
		}
	case "after-remove":
		if dockerCommand(t, ctx, "ps", "-aq", "--filter", "label=io.antnest.agent-id="+job.Agent) != "" {
			t.Fatal("source removal checkpoint has compute")
		}
	default:
		target := inspectCrashContainer(t, ctx, name)
		if target.ID == original.ID || target.Labels["io.antnest.runtime-generation"] != "2" || target.Labels["io.antnest.runtime-spec-digest"] != pending.SpecDigest {
			t.Fatal("checkpoint target identity mismatch")
		}
		targetBefore = target.ID
	}
	if dockerCommand(t, ctx, "volume", "inspect", volume) != volumeBefore {
		t.Fatal("checkpoint changed workspace identity")
	}
	changed := job.Configuration
	changed.Resources.MemoryBytes += 1024
	_, err = service.UpdateRuntime(ctx, pending.RequestID, job.Agent, job.Source, changed)
	if !errors.Is(err, control.ErrRequestConflict) {
		t.Fatalf("changed retry accepted: %v", err)
	}
	if phase != "after-commit" {
		_, err = service.UpdateRuntime(ctx, "competing-"+job.Agent, job.Agent, job.Source, job.Configuration)
		if !errors.Is(err, control.ErrAgentMutationInProgress) {
			t.Fatalf("competing request bypassed pending mutation: %v", err)
		}
	}
	job.Phase = ""
	runCrashChild(t, ctx, job, 0)
	recovered, err := repo.GetOperation(ctx, pending.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != deployment.OperationCompleted || recovered.RuntimeRevision != pending.RuntimeRevision || recovered.Generation != pending.Generation || recovered.SpecDigest != pending.SpecDigest || recovered.SourceRevision != pending.SourceRevision {
		t.Fatal("recovery changed immutable identity or did not complete")
	}
	published, err := repo.GetEnvironment(ctx, job.Agent)
	if err != nil || published.OperationID != "" || published.RuntimeRevision != recovered.RuntimeRevision || published.Generation != recovered.Generation || published.SpecDigest != recovered.SpecDigest || published.LifecycleState != deployment.LifecycleProvisioned {
		t.Fatal("recovery did not atomically publish and release the target")
	}
	claim, err := repo.GenerationClaim(ctx, recovered.RuntimeKey())
	if err != nil || claim.RuntimeRevision != recovered.RuntimeRevision || claim.SpecDigest != recovered.SpecDigest {
		t.Fatal("target generation claim changed")
	}
	attempt := uint64(2)
	if phase == "after-commit" {
		attempt = 1
	}
	if uint64(recovered.Attempt) != attempt {
		t.Fatal("wrong recovered attempt")
	}
	target := inspectCrashContainer(t, ctx, name)
	if target.ID == original.ID || (targetBefore != "" && target.ID != targetBefore) {
		t.Fatal("recovery replaced an existing target")
	}
	if target.Labels["io.antnest.runtime-spec-digest"] != recovered.SpecDigest {
		t.Fatal("target does not match durable digest")
	}
	if got := dockerCommand(t, ctx, "exec", name, "cat", "/workspace/.crash-sentinel"); got != "crash-recovery-sentinel" {
		t.Fatal("workspace bytes lost")
	}
	if dockerCommand(t, ctx, "volume", "inspect", volume) != volumeBefore {
		t.Fatal("recovery replaced workspace")
	}
	assertCrashCounts(t, ctx, db, job.Agent, 1)
	effects, err := os.ReadFile(job.Events)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(string(effects)), "\n") {
		counts[strings.Fields(line)[0]]++
	}
	if !reflect.DeepEqual(counts, map[string]int{"create": 2, "start": 2, "stop": 1, "remove": 1}) {
		t.Fatalf("duplicate physical effects: %v", counts)
	}
	runCrashChild(t, ctx, job, 0)
	replay, err := repo.GetOperation(ctx, pending.RequestID)
	if err != nil || !reflect.DeepEqual(replay, recovered) {
		t.Fatal("terminal replay changed journal")
	}
	after, err := os.ReadFile(job.Events)
	if err != nil || string(after) != string(effects) {
		t.Fatal("terminal replay repeated physical work")
	}
	if inspectCrashContainer(t, ctx, name).ID != target.ID {
		t.Fatal("terminal replay replaced target")
	}
	assertCrashCounts(t, ctx, db, job.Agent, 1)
	if directory := os.Getenv("ANTNEST_RUNTIME_CRASH_EVIDENCE"); directory != "" {
		data, err := json.Marshal(map[string]any{"phase": phase, "request_id": pending.RequestID, "source_revision": source.RuntimeRevision, "target_revision": recovered.RuntimeRevision, "generation": recovered.Generation, "attempt": recovered.Attempt, "target_id": target.ID, "workspace": volume, "effects": counts, "updated_observations": 1, "terminal_replay_unchanged": true})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, job.Agent+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	deleted, err := service.DeleteRuntime(ctx, "delete-"+job.Agent, job.Agent, recovered.RuntimeRevision)
	if err != nil || deleted.State != deployment.OperationCompleted {
		t.Fatal("public service deletion failed")
	}
	t.Log("real process exit, immutable target/workspace, exact effect counts and replay verified")
}

func assertCrashCounts(t *testing.T, ctx context.Context, db *sql.DB, agent string, updates int) {
	t.Helper()
	var claims, observed int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM runtime_controller.generation_claims WHERE agent_id=$1", agent).Scan(&claims); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM runtime_controller.observations WHERE agent_id=$1 AND kind='updated'", agent).Scan(&observed); err != nil {
		t.Fatal(err)
	}
	if claims != 2 || observed != updates {
		t.Fatalf("claims/updated observations: %d/%d, want 2/%d", claims, observed, updates)
	}
}

func runCrashChild(t *testing.T, ctx context.Context, job crashJob, expected int) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "job.json")
	data, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	childCtx, cancel := context.WithTimeout(ctx, 70*time.Second)
	defer cancel()
	cmd := exec.CommandContext(childCtx, binary, "-test.run=^TestRuntimeUpdateCrashChild$", "-test.timeout=65s")
	cmd.Env = append(os.Environ(), "ANTNEST_RUNTIME_CRASH_JOB="+path)
	cmd.WaitDelay = 5 * time.Second
	output, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		var exited *exec.ExitError
		if !errors.As(err, &exited) {
			t.Fatal("child could not start or be reaped")
		}
		code = exited.ExitCode()
	}
	if code != expected {
		t.Fatalf("child exit=%d want=%d: %s", code, expected, output)
	}
}

func dockerCommand(t *testing.T, ctx context.Context, args ...string) string {
	t.Helper()
	commandCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, "docker", args...)
	cmd.WaitDelay = 5 * time.Second
	output, err := cmd.Output()
	if err != nil {
		if args[0] == "exec" && os.Getenv("ANTNEST_RUNTIME_CRASH_EVIDENCE") != "" {
			logs, _ := exec.CommandContext(commandCtx, "docker", "logs", args[1]).CombinedOutput()
			_ = os.WriteFile(filepath.Join(os.Getenv("ANTNEST_RUNTIME_CRASH_EVIDENCE"), args[1]+".log"), logs, 0600)
		}
		t.Fatalf("Docker %s failed (output withheld)", args[0])
	}
	return strings.TrimSpace(string(output))
}
func inspectCrashContainer(t *testing.T, ctx context.Context, name string) dockerplatform.Container {
	t.Helper()
	var rows []struct {
		ID     string `json:"Id"`
		Config struct{ Labels map[string]string }
	}
	if err := json.Unmarshal([]byte(dockerCommand(t, ctx, "inspect", name)), &rows); err != nil || len(rows) != 1 {
		t.Fatal("invalid Docker inspection")
	}
	return dockerplatform.Container{ID: rows[0].ID, Labels: rows[0].Config.Labels}
}

func newCrashFixture(t *testing.T, ctx context.Context) crashJob {
	t.Helper()
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	scope := "antnest-rc-crash-" + hex.EncodeToString(nonce[:])
	t.Log("Disposable crash component scope:", scope)
	job := crashJob{Scope: scope, Network: scope, Skills: scope + "-skills"}
	socket := strings.TrimPrefix(dockerCommand(t, ctx, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"), "unix://")
	if !filepath.IsAbs(socket) {
		t.Fatal("component fixture requires a local Unix Docker context")
	}
	job.Socket = socket
	image := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_CRASH_IMAGE")
	if image == "" {
		image = "antnest/antnest-runtime:local"
	}
	dockerCommand(t, ctx, "image", "inspect", image)
	dockerCommand(t, ctx, "image", "inspect", "postgres:17-bookworm")
	dockerCommand(t, ctx, "image", "inspect", "node:24-bookworm-slim")
	t.Cleanup(func() {
		// Independent command budgets let cleanup attempt every owned resource.
		cleanupCommand := func(args ...string) (string, bool) {
			cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(cleanup, "docker", args...)
			cmd.WaitDelay = 5 * time.Second
			output, err := cmd.Output()
			if err != nil {
				t.Errorf("owned %s cleanup failed (output withheld)", args[0])
				return "", false
			}
			return strings.TrimSpace(string(output)), true
		}
		for _, resource := range []string{"container", "volume", "network"} {
			args := []string{resource, "ls", "-q", "--filter", "label=" + crashLabel + "=" + scope}
			if resource == "container" {
				args = []string{"ps", "-aq", "--filter", "label=" + crashLabel + "=" + scope}
			}
			ids, ok := cleanupCommand(args...)
			if !ok {
				continue
			}
			for _, id := range strings.Fields(ids) {
				remove := []string{resource, "rm"}
				if resource == "container" {
					remove = append(remove, "-f", "-v")
				}
				cleanupCommand(append(remove, id)...)
			}
			if remaining, ok := cleanupCommand(args...); ok && remaining != "" {
				t.Errorf("owned %s resources remain", resource)
			}
		}
	})
	dockerCommand(t, ctx, "network", "create", "--internal", "--label", crashLabel+"="+scope, scope)
	dockerCommand(t, ctx, "volume", "create", "--label", crashLabel+"="+scope, job.Skills)
	// A local UDP sink keeps the real Runtime network transport alive. This fixture
	// does not exercise packet policy or replace the separate egress acceptance.
	dockerCommand(t, ctx, "run", "-d", "--pull=never", "--name", scope+"-peer", "--label", crashLabel+"="+scope,
		"--network", scope, "node:24-bookworm-slim", "node", "-e",
		`require("node:dgram").createSocket("udp4").bind(8092, "0.0.0.0", () => console.log("ready"))`)
	for dockerCommand(t, ctx, "logs", scope+"-peer") != "ready" {
		select {
		case <-ctx.Done():
			t.Fatal("network peer startup expired")
		case <-time.After(100 * time.Millisecond):
		}
	}
	peerIP := dockerCommand(t, ctx, "inspect", scope+"-peer", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}")

	password := hex.EncodeToString(nonce[:]) + "fixture"
	dockerCommand(t, ctx, "run", "-d", "--pull=never", "--name", scope+"-postgres", "--label", crashLabel+"="+scope, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD="+password, "-e", "POSTGRES_DB=crash_fixture", "postgres:17-bookworm")
	port := dockerCommand(t, ctx, "port", scope+"-postgres", "5432/tcp")
	job.Database = "postgres://postgres:" + password + "@" + port + "/crash_fixture?sslmode=disable"
	var db *sql.DB
	for ctx.Err() == nil {
		attempt, cancel := context.WithTimeout(ctx, 2*time.Second)
		var err error
		db, err = postgres.OpenDatabase(attempt, job.Database, 4, 1)
		cancel()
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
		}
	}
	if db == nil {
		t.Fatal("dedicated PostgreSQL did not become ready")
	}
	defer func() { _ = db.Close() }()
	if err := postgres.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	job.Configuration = deployment.Configuration{ImageRef: image, Network: deployment.NetworkSpec{
		PacketContractRevision: 1, EgressEndpoint: deployment.IPv4Endpoint{IPv4: peerIP, Port: 8092}, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
	}, Resources: deployment.ResourceLimits{MemoryBytes: 512 << 20, PidsLimit: 256, TmpfsBytes: 64 << 20}}
	return job
}
