package docker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestCreateReusesExactRunningContainer(t *testing.T) {
	engine := newFakeEngine()
	engine.container = exactContainer()
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectCompleted || engine.createCalls != 0 || engine.removeCalls != 0 {
		t.Fatalf("exact Runtime was mutated: outcome=%+v engine=%+v", outcome, engine)
	}
}

func TestCreateRejectsDifferentGenerationWithoutReplacingIt(t *testing.T) {
	engine := newFakeEngine()
	engine.container = exactContainer()
	engine.container.Labels[labelGeneration] = "6"
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_drift" {
		t.Fatalf("conflict was not reported: %+v", outcome)
	}
	if engine.stopCalls != 0 || engine.removeCalls != 0 || engine.createCalls != 0 {
		t.Fatalf("conflicting Runtime was replaced: %+v", engine)
	}
}

func TestCreateDistinguishesMissingStorageFromDockerFailure(t *testing.T) {
	for _, test := range []struct {
		name   string
		volume string
	}{
		{name: "workspace", volume: "antnest-workspace-agent-1"},
		{name: "system Skills", volume: "antnest-system-skills"},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := newFakeEngine()
			engine.inspectVolumeErrors[test.volume] = errors.New("Docker daemon unavailable")
			driver := newTestDriver(t, engine)

			outcome := driver.Create(context.Background(), testDeployment(), testDigest)

			if outcome.State != deployment.EffectNotStarted || outcome.Code != "platform_unavailable" {
				t.Fatalf("Docker storage probe failure was misclassified: %+v", outcome)
			}
		})
	}
}

func TestCreateMapsImmutableRuntimeSpecToHardenedContainer(t *testing.T) {
	engine := newFakeEngine()
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectCompleted || engine.createCalls != 1 || engine.startCalls != 1 {
		t.Fatalf("unexpected create: outcome=%+v engine=%+v", outcome, engine)
	}
	spec := engine.created
	if spec.Name != "antnest-runtime-agent-1" || spec.Image != testDeployment().ImageRef {
		t.Fatalf("wrong Docker identity: %+v", spec)
	}
	if spec.ReadOnlyRootFS || spec.Environment["ANTNEST_RUNTIME_SPEC"] == "" || spec.User != "0:0" {
		t.Fatalf("Runtime bootstrap was not hardened: %+v", spec)
	}
	if spec.Mounts["/workspace"].Source != "antnest-workspace-agent-1" ||
		!spec.Mounts["/skills"].ReadOnly {
		t.Fatalf("unexpected mounts: %+v", spec.Mounts)
	}
	if spec.RestartPolicy != "unless-stopped" || len(spec.Healthcheck.Test) == 0 {
		t.Fatalf("container lifecycle policy missing: %+v", spec)
	}
	if spec.Labels[labelSpecDigest] != testDigest || spec.Labels[labelGeneration] != "7" {
		t.Fatalf("immutable labels missing: %+v", spec.Labels)
	}
}

func TestDeploymentDigestCoversControllerPhysicalMapping(t *testing.T) {
	first := newTestDriver(t, newFakeEngine())
	firstDigest, err := first.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewDriver(newFakeEngine(), Config{
		ManagementNetwork:  "another-runtime-network",
		SystemSkillsVolume: "antnest-system-skills",
		RuntimeOTEL:        map[string]string{"OTEL_SDK_DISABLED": "true"},
	})
	if err != nil {
		t.Fatal(err)
	}
	secondDigest, err := second.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest == secondDigest {
		t.Fatal("Controller-injected physical configuration was omitted from the deployment digest")
	}
}

func TestCreatePreservesAmbiguousDockerMutation(t *testing.T) {
	engine := newFakeEngine()
	engine.createErr = Uncertain(errors.New("connection reset"))
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectUnknown {
		t.Fatalf("ambiguous create was collapsed: %+v", outcome)
	}
}

func TestCreateConvergesAfterConcurrentCreate(t *testing.T) {
	engine := newFakeEngine()
	engine.createErr = ErrConflict
	engine.createMaterializes = true
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectCompleted || engine.createCalls != 1 || engine.startCalls != 1 {
		t.Fatalf("concurrent create did not converge: outcome=%+v engine=%+v", outcome, engine)
	}
}

func TestCreatePreservesConflictWhenConcurrentResourceCannotBeInspected(t *testing.T) {
	engine := newFakeEngine()
	engine.createErr = ErrConflict
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectUnknown {
		t.Fatalf("unverified concurrent create was collapsed: %+v", outcome)
	}
}

func TestEnsureStorageConvergesAfterConcurrentCreate(t *testing.T) {
	engine := newFakeEngine()
	delete(engine.volumes, "antnest-workspace-agent-1")
	engine.createVolumeErr = ErrConflict
	engine.createVolumeMaterializes = true
	driver := newTestDriver(t, engine)

	outcome := driver.EnsureStorage(context.Background(), "agent-1")

	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("concurrent volume create did not converge: %+v", outcome)
	}
}

func TestEnsureStoragePreservesConflictWhenVolumeCannotBeInspected(t *testing.T) {
	engine := newFakeEngine()
	delete(engine.volumes, "antnest-workspace-agent-1")
	engine.createVolumeErr = ErrConflict
	driver := newTestDriver(t, engine)

	outcome := driver.EnsureStorage(context.Background(), "agent-1")

	if outcome.State != deployment.EffectUnknown {
		t.Fatalf("unverified concurrent volume create was collapsed: %+v", outcome)
	}
}

func TestVerifyStorageRejectsMissingOrForeignWorkspace(t *testing.T) {
	for _, prepare := range []func(*fakeEngine){
		func(engine *fakeEngine) { delete(engine.volumes, "antnest-workspace-agent-1") },
		func(engine *fakeEngine) {
			engine.volumes["antnest-workspace-agent-1"] = Volume{
				Name: "antnest-workspace-agent-1", Labels: map[string]string{"owner": "foreign"},
			}
		},
	} {
		engine := newFakeEngine()
		prepare(engine)
		driver := newTestDriver(t, engine)
		outcome := driver.VerifyStorage(context.Background(), "agent-1")
		if outcome.State != deployment.EffectNotStarted {
			t.Fatalf("invalid retained workspace was accepted: %+v", outcome)
		}
	}
}

func TestVerifyStorageDoesNotConflateWorkspaceWithSystemSkills(t *testing.T) {
	engine := newFakeEngine()
	delete(engine.volumes, "antnest-system-skills")
	driver := newTestDriver(t, engine)

	outcome := driver.VerifyStorage(context.Background(), "agent-1")

	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("global system-Skills readiness leaked into Agent workspace: %+v", outcome)
	}
}

func TestCreateStillRequiresSystemSkillsVolume(t *testing.T) {
	engine := newFakeEngine()
	delete(engine.volumes, "antnest-system-skills")
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectNotStarted || outcome.Code != "storage_not_found" {
		t.Fatalf("Runtime creation accepted a missing system-Skills volume: %+v", outcome)
	}
}

func TestDeleteDoesNotRemoveWorkspace(t *testing.T) {
	engine := newFakeEngine()
	engine.container = exactContainer()
	driver := newTestDriver(t, engine)

	outcome := driver.Delete(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, testDigest)

	if outcome.State != deployment.EffectCompleted || engine.removeCalls != 1 || engine.removeVolumeCalls != 0 {
		t.Fatalf("delete crossed storage boundary: outcome=%+v engine=%+v", outcome, engine)
	}
}

func TestDeleteRejectsIncompleteOrDifferentOwnership(t *testing.T) {
	for _, mutate := range []func(*Container){
		func(value *Container) { delete(value.Labels, labelManaged) },
		func(value *Container) { value.Labels[labelSpecDigest] = "sha256:" + strings.Repeat("b", 64) },
	} {
		engine := newFakeEngine()
		engine.container = exactContainer()
		mutate(engine.container)
		driver := newTestDriver(t, engine)
		outcome := driver.Delete(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, testDigest)
		if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_drift" ||
			engine.removeCalls != 0 {
			t.Fatalf("foreign Runtime was deleted: outcome=%+v engine=%+v", outcome, engine)
		}
	}
}

func TestInspectRejectsContainerOwnedByAnotherGeneration(t *testing.T) {
	engine := newFakeEngine()
	engine.container = exactContainer()
	engine.container.Labels[labelGeneration] = "8"
	driver := newTestDriver(t, engine)

	_, err := driver.Inspect(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7})

	if !errors.Is(err, deployment.ErrIdentityConflict) {
		t.Fatalf("wrong-generation Runtime was accepted: %v", err)
	}
}

func TestDeleteStorageRefusesWhileManagedRuntimeExists(t *testing.T) {
	engine := newFakeEngine()
	engine.container = exactContainer()
	driver := newTestDriver(t, engine)

	outcome := driver.DeleteStorage(context.Background(), "agent-1")

	if outcome.State != deployment.EffectNotStarted || outcome.Code != "storage_in_use" || engine.removeVolumeCalls != 0 {
		t.Fatalf("mounted storage was deleted: outcome=%+v engine=%+v", outcome, engine)
	}
}

func TestDeleteStorageRejectsSameNameForeignVolume(t *testing.T) {
	engine := newFakeEngine()
	engine.volumes["antnest-workspace-agent-1"] = Volume{
		Name: "antnest-workspace-agent-1", Labels: map[string]string{"owner": "another-system"},
	}
	driver := newTestDriver(t, engine)

	outcome := driver.DeleteStorage(context.Background(), "agent-1")

	if outcome.State != deployment.EffectNotStarted || outcome.Code != "storage_ownership_conflict" ||
		engine.removeVolumeCalls != 0 {
		t.Fatalf("foreign volume was adopted or deleted: outcome=%+v engine=%+v", outcome, engine)
	}
}

func TestCreateRejectsSameNameForeignWorkspaceVolume(t *testing.T) {
	engine := newFakeEngine()
	engine.volumes["antnest-workspace-agent-1"] = Volume{
		Name: "antnest-workspace-agent-1", Labels: map[string]string{"owner": "another-system"},
	}
	driver := newTestDriver(t, engine)

	outcome := driver.Create(context.Background(), testDeployment(), testDigest)

	if outcome.State != deployment.EffectNotStarted || outcome.Code != "storage_ownership_conflict" ||
		engine.createCalls != 0 {
		t.Fatalf("foreign volume was mounted: outcome=%+v engine=%+v", outcome, engine)
	}
}

func TestReadyRequiresManagementNetworkAndSystemSkillsVolume(t *testing.T) {
	engine := newFakeEngine()
	driver := newTestDriver(t, engine)
	delete(engine.networks, "antnest-runtime-management")
	if err := driver.Ready(context.Background()); err == nil {
		t.Fatal("missing management network was accepted")
	}
	engine.networks["antnest-runtime-management"] = true
	delete(engine.volumes, "antnest-system-skills")
	if err := driver.Ready(context.Background()); err == nil {
		t.Fatal("missing system Skills volume was accepted")
	}
}

func TestReadyUsesLightweightInventoryProbe(t *testing.T) {
	engine := newFakeEngine()
	engine.container = exactContainer()
	delete(engine.container.Labels, labelGeneration)
	driver := newTestDriver(t, engine)
	if err := driver.Ready(context.Background()); err != nil {
		t.Fatalf("readiness inspected fleet contents: %v", err)
	}
	if engine.probeCalls != 1 || engine.listCalls != 0 {
		t.Fatalf("readiness calls: probe=%d full-list=%d", engine.probeCalls, engine.listCalls)
	}
}

func TestListRejectsMalformedManagedRuntime(t *testing.T) {
	engine := newFakeEngine()
	engine.container = exactContainer()
	delete(engine.container.Labels, labelGeneration)
	driver := newTestDriver(t, engine)
	if _, err := driver.List(context.Background()); err == nil {
		t.Fatal("malformed managed Runtime was silently omitted")
	}
}

func TestWatchNormalizesOnlyManagedRuntimeFacts(t *testing.T) {
	engine := newFakeEngine()
	engine.events = []ContainerEvent{
		{ID: "container-1", Action: "health_status: healthy", Attributes: map[string]string{
			labelManaged: "runtime", labelAgentID: "agent-1", labelGeneration: "7", labelSpecDigest: testDigest,
		}},
		{ID: "container-3", Action: "rename", Attributes: map[string]string{
			labelManaged: "runtime", labelAgentID: "agent-1", labelGeneration: "7", labelSpecDigest: testDigest,
		}},
	}
	driver := newTestDriver(t, engine)
	var observations []deployment.Observation
	if err := driver.Watch(context.Background(), time.Unix(100, 0), func(context.Context) error {
		return nil
	}, func(_ context.Context, value deployment.Observation) error {
		observations = append(observations, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(observations) != 1 || observations[0].Kind != deployment.ObservationHealthy ||
		observations[0].AgentID != "agent-1" || observations[0].Generation != 7 ||
		observations[0].SpecDigest != testDigest {
		t.Fatalf("unexpected normalized observations: %+v", observations)
	}
}

func TestWatchRejectsMalformedManagedRuntimeEvent(t *testing.T) {
	engine := newFakeEngine()
	engine.events = []ContainerEvent{{
		ID: "container-1", Action: "start",
		Attributes: map[string]string{labelManaged: "runtime", labelAgentID: "agent-1"},
	}}
	driver := newTestDriver(t, engine)
	if err := driver.Watch(context.Background(), time.Time{}, func(context.Context) error {
		return nil
	}, func(context.Context, deployment.Observation) error {
		return nil
	}); err == nil {
		t.Fatal("malformed managed Runtime event was silently ignored")
	}
}

var testDigest = func() string {
	driver, err := NewDriver(newFakeEngine(), testDriverConfig())
	if err != nil {
		panic(err)
	}
	digest, err := driver.DeploymentDigest(testDeployment())
	if err != nil {
		panic(err)
	}
	return digest
}()

func testDeployment() deployment.Deployment {
	return deployment.Deployment{
		ImageRef: "antnest/antnest-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RuntimeSpec: deployment.RuntimeSpec{
			AgentID: "agent-1", Generation: 7,
			Listen: deployment.SocketAddress{Host: "0.0.0.0", Port: 8093},
			Network: deployment.NetworkSpec{
				PacketContractRevision: 1,
				EgressEndpoint:         deployment.IPv4Endpoint{IPv4: "10.20.0.8", Port: 8092},
				TunnelIPv4:             "100.64.0.2", ResolverIPv4: "100.64.0.1",
			},
			Filesystem: deployment.FilesystemSpec{Workspace: "/workspace", SystemSkills: "/skills"},
		},
		Resources: deployment.ResourceLimits{MemoryBytes: 2 << 30, PidsLimit: 512, TmpfsBytes: 512 << 20},
	}
}

func exactContainer() *Container {
	return &Container{
		ID: "container-1", Name: "antnest-runtime-agent-1", Running: true, Health: "healthy",
		Labels: map[string]string{
			labelManaged: "runtime", labelAgentID: "agent-1", labelGeneration: "7",
			labelSpecDigest: testDigest, "io.antnest.runtime-port": "8093",
		},
	}
}

func newTestDriver(t *testing.T, engine *fakeEngine) *Driver {
	t.Helper()
	driver, err := NewDriver(engine, testDriverConfig())
	if err != nil {
		t.Fatalf("new Docker driver: %v", err)
	}
	return driver
}

func testDriverConfig() Config {
	return Config{
		ManagementNetwork: "antnest-runtime-management", SystemSkillsVolume: "antnest-system-skills",
	}
}

type fakeEngine struct {
	container                *Container
	created                  ContainerSpec
	createCalls              int
	startCalls               int
	stopCalls                int
	removeCalls              int
	removeVolumeCalls        int
	createErr                error
	createMaterializes       bool
	createVolumeErr          error
	createVolumeMaterializes bool
	inspectVolumeErrors      map[string]error
	volumes                  map[string]Volume
	networks                 map[string]bool
	events                   []ContainerEvent
	probeCalls               int
	listCalls                int
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{
		volumes: map[string]Volume{
			"antnest-workspace-agent-1": {
				Name: "antnest-workspace-agent-1", Labels: map[string]string{
					labelManaged: "workspace", labelAgentID: "agent-1",
				},
			},
			"antnest-system-skills": {Name: "antnest-system-skills"},
		},
		networks:            map[string]bool{"antnest-runtime-management": true},
		inspectVolumeErrors: map[string]error{},
	}
}

func (*fakeEngine) Ping(context.Context) error { return nil }

func (e *fakeEngine) ListManagedContainerIDs(context.Context) ([]string, error) {
	e.probeCalls++
	if e.container == nil {
		return nil, nil
	}
	return []string{e.container.ID}, nil
}

func (e *fakeEngine) InspectContainer(context.Context, string) (Container, error) {
	if e.container == nil {
		return Container{}, ErrNotFound
	}
	return *e.container, nil
}

func (e *fakeEngine) ListManagedContainers(context.Context) ([]Container, error) {
	e.listCalls++
	if e.container == nil {
		return nil, nil
	}
	return []Container{*e.container}, nil
}

func (e *fakeEngine) WatchManagedEvents(
	_ context.Context, _ time.Time, ready func() error, emit func(ContainerEvent) error,
) error {
	if err := ready(); err != nil {
		return err
	}
	for _, event := range e.events {
		if err := emit(event); err != nil {
			return err
		}
	}
	return nil
}

func (e *fakeEngine) InspectVolume(_ context.Context, name string) (Volume, error) {
	if err := e.inspectVolumeErrors[name]; err != nil {
		return Volume{}, err
	}
	value, ok := e.volumes[name]
	if !ok {
		return Volume{}, ErrNotFound
	}
	return value, nil
}

func (e *fakeEngine) CreateVolume(_ context.Context, name string, labels map[string]string) error {
	if e.createVolumeMaterializes {
		e.volumes[name] = Volume{Name: name, Labels: labels}
	}
	if e.createVolumeErr != nil {
		return e.createVolumeErr
	}
	e.volumes[name] = Volume{Name: name, Labels: labels}
	return nil
}

func (e *fakeEngine) InspectNetwork(_ context.Context, name string) error {
	if !e.networks[name] {
		return ErrNotFound
	}
	return nil
}

func (e *fakeEngine) RemoveVolume(_ context.Context, name string) error {
	e.removeVolumeCalls++
	delete(e.volumes, name)
	return nil
}

func (e *fakeEngine) CreateContainer(_ context.Context, spec ContainerSpec) (string, error) {
	e.createCalls++
	e.created = spec
	if e.createMaterializes {
		e.container = &Container{ID: "created", Name: spec.Name, Labels: spec.Labels}
	}
	if e.createErr != nil {
		return "", e.createErr
	}
	e.container = &Container{ID: "created", Name: spec.Name, Labels: spec.Labels}
	return "created", nil
}

func (e *fakeEngine) StartContainer(context.Context, string) error {
	e.startCalls++
	if e.container != nil {
		e.container.Running = true
		e.container.Health = "starting"
	}
	return nil
}

func (e *fakeEngine) StopContainer(context.Context, string) error {
	e.stopCalls++
	if e.container != nil {
		e.container.Running = false
	}
	return nil
}

func (e *fakeEngine) RemoveContainer(context.Context, string) error {
	e.removeCalls++
	e.container = nil
	return nil
}
