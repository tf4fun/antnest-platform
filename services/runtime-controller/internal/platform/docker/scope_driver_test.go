package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type scopedEngine struct {
	mu             sync.Mutex
	containers     map[string]*Container
	byID           map[string]string
	nextID         int
	volumes        map[string]Volume
	networks       map[string]Network
	mgmtNetwork    string
	pendingIPv4    map[string]string
	renameErr      error
	networkErr     error
	createErr      error
	startErr       error
	removeErr      error
	renamed        [][2]string
	createdSpecs   []ContainerSpec
	started        []string
	stopped        []string
	removed        []string
	removedVolumes []string
}

func newScopedEngine(scope string) *scopedEngine {
	engine := &scopedEngine{
		containers:  map[string]*Container{},
		byID:        map[string]string{},
		volumes:     map[string]Volume{},
		mgmtNetwork: "antnest-runtime-management",
		pendingIPv4: map[string]string{},
		networks: map[string]Network{
			"antnest-runtime-management": {
				Name: "antnest-runtime-management",
				IPAM: []NetworkIPAM{{
					Subnet:             "172.30.255.0/24",
					Gateway:            "172.30.255.1",
					AuxiliaryAddresses: map[string]string{"egress": "172.30.255.3", "controller": "172.30.255.4"},
				}},
				Containers: map[string]string{},
			},
		},
	}
	engine.volumes["antnest-system-skills"] = Volume{Name: "antnest-system-skills"}
	return engine
}

func scopedWorkspace(engine *scopedEngine, scope, agentID string) {
	name := workspaceVolumeName(scope, agentID)
	engine.volumes[name] = Volume{Name: name, Labels: map[string]string{
		labelManaged: "workspace", labelScope: scope, labelAgentID: agentID,
	}}
}

func scopedContainer(agentID string, generation uint64, scope, digest string, running bool) *Container {
	return &Container{
		ID: "cid-" + scope + "-" + agentID, Name: runtimeContainerName(scope, agentID),
		Running: running, Status: map[bool]string{true: "running", false: "exited"}[running],
		Labels: map[string]string{
			labelManaged: "runtime", labelScope: scope, labelAgentID: agentID,
			labelGeneration: strconv.FormatUint(generation, 10), labelSpecDigest: digest,
			"io.antnest.runtime-port": "8093",
		},
	}
}

func legacyContainer(agentID string, generation uint64, scope, digest string, running bool) *Container {
	container := scopedContainer(agentID, generation, scope, digest, running)
	container.ID = "cid-legacy-" + agentID
	container.Name = containerName(agentID)
	return container
}

func (e *scopedEngine) Ping(context.Context) error { return nil }

func (e *scopedEngine) InspectImage(context.Context, string) (string, error) { return "", ErrNotFound }

func (e *scopedEngine) inspectContainer(identifier string) (Container, error) {
	if container, ok := e.containers[identifier]; ok {
		return *container, nil
	}
	if name, ok := e.byID[identifier]; ok {
		return *e.containers[name], nil
	}
	return Container{}, ErrNotFound
}

func (e *scopedEngine) InspectContainer(_ context.Context, identifier string) (Container, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.inspectContainer(identifier)
}

func (e *scopedEngine) ListManagedContainerIDs(context.Context) ([]string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var ids []string
	for _, container := range e.containers {
		if container.Labels[labelManaged] == "runtime" {
			ids = append(ids, container.ID)
		}
	}
	return ids, nil
}

func (e *scopedEngine) ListManagedContainers(context.Context) ([]Container, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var result []Container
	for _, container := range e.containers {
		if container.Labels[labelManaged] == "runtime" {
			result = append(result, *container)
		}
	}
	return result, nil
}

func (e *scopedEngine) WatchManagedEvents(
	_ context.Context, _ time.Time, ready func() error, _ func(ContainerEvent) error,
) error {
	return ready()
}

func (e *scopedEngine) InspectVolume(_ context.Context, name string) (Volume, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	volume, ok := e.volumes[name]
	if !ok {
		return Volume{}, ErrNotFound
	}
	return volume, nil
}

func (e *scopedEngine) CreateVolume(_ context.Context, name string, labels map[string]string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.volumes[name]; ok {
		return ErrConflict
	}
	e.volumes[name] = Volume{Name: name, Labels: labels}
	return nil
}

func (e *scopedEngine) CreateQuotaVolume(_ context.Context, name string, labels map[string]string, driver string, options map[string]string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.volumes[name]; ok {
		return ErrConflict
	}
	e.volumes[name] = Volume{Name: name, Driver: driver, Options: options, Labels: labels}
	return nil
}

func (e *scopedEngine) RemoveVolume(_ context.Context, name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.removedVolumes = append(e.removedVolumes, name)
	if _, ok := e.volumes[name]; !ok {
		return ErrNotFound
	}
	delete(e.volumes, name)
	return nil
}

func (e *scopedEngine) InspectNetwork(_ context.Context, name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.networks[name]; !ok {
		return ErrNotFound
	}
	return nil
}

func (e *scopedEngine) InspectNetworkDetails(_ context.Context, name string) (Network, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.networkErr != nil {
		return Network{}, e.networkErr
	}
	network, ok := e.networks[name]
	if !ok {
		return Network{}, ErrNotFound
	}
	return network, nil
}

func (e *scopedEngine) RenameContainer(_ context.Context, id, name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.renameErr != nil {
		return e.renameErr
	}
	old, ok := e.byID[id]
	if !ok {
		return ErrNotFound
	}
	if _, exists := e.containers[name]; exists {
		return ErrConflict
	}
	container := e.containers[old]
	delete(e.containers, old)
	container.Name = name
	e.containers[name] = container
	e.byID[id] = name
	e.renamed = append(e.renamed, [2]string{old, name})
	return nil
}

func (e *scopedEngine) CreateContainer(_ context.Context, spec ContainerSpec) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.createErr != nil {
		return "", e.createErr
	}
	if _, ok := e.containers[spec.Name]; ok {
		return "", ErrConflict
	}
	e.nextID++
	id := fmt.Sprintf("created-%d", e.nextID)
	mounts := make([]ObservedMount, 0, len(spec.Mounts))
	for target, mount := range spec.Mounts {
		mounts = append(mounts, ObservedMount{Type: "volume", Name: mount.Source, Destination: target})
	}
	e.containers[spec.Name] = &Container{
		ID: id, Name: spec.Name, Status: "created", Labels: spec.Labels, Mounts: mounts,
	}
	e.byID[id] = spec.Name
	e.createdSpecs = append(e.createdSpecs, spec)
	return id, nil
}

func (e *scopedEngine) StartContainer(_ context.Context, identifier string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.started = append(e.started, identifier)
	container, err := e.inspectContainer(identifier)
	if err != nil {
		return err
	}
	if e.startErr != nil {
		return e.startErr
	}
	e.containers[container.Name].Running = true
	e.containers[container.Name].Status = "running"
	if ip, ok := e.pendingIPv4[container.Name]; ok {
		e.containers[container.Name].NetworkIPv4 = map[string]string{e.mgmtNetwork: ip}
		network := e.networks[e.mgmtNetwork]
		network.Containers[container.ID] = ip + "/24"
		e.networks[e.mgmtNetwork] = network
	}
	return nil
}

func (e *scopedEngine) StopContainer(_ context.Context, identifier string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stopped = append(e.stopped, identifier)
	container, err := e.inspectContainer(identifier)
	if err != nil {
		return err
	}
	e.containers[container.Name].Running = false
	e.containers[container.Name].Status = "exited"
	return nil
}

func (e *scopedEngine) PutArchive(context.Context, string, string, io.Reader) error {
	return nil
}

func (e *scopedEngine) GetArchive(context.Context, string, string) (io.ReadCloser, error) {
	return nil, errors.New("archive unavailable")
}

func (e *scopedEngine) RemoveContainer(_ context.Context, identifier string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.removed = append(e.removed, identifier)
	if e.removeErr != nil {
		return e.removeErr
	}
	container, err := e.inspectContainer(identifier)
	if err != nil {
		return ErrNotFound
	}
	delete(e.containers, container.Name)
	delete(e.byID, container.ID)
	return nil
}

func scopedDriver(t *testing.T, engine *scopedEngine, scope string) *Driver {
	t.Helper()
	driver, err := NewDriver(engine, Config{
		ControllerScope: scope, ManagementNetwork: "antnest-runtime-management",
		SystemSkillsVolume: "antnest-system-skills",
		ResolverMountGate:  &fakeResolverGate{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return driver
}

func TestCreateUsesExactScopedResourceNames(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	driver := scopedDriver(t, engine, "test-controller")
	digest, err := driver.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	outcome := driver.Create(context.Background(), testDeployment(), digest)
	if outcome.State != deployment.EffectCompleted || len(engine.createdSpecs) != 1 {
		t.Fatalf("create = %+v engine=%+v", outcome, engine.createdSpecs)
	}
	spec := engine.createdSpecs[0]
	if spec.Name != "antnest-test-controller-runtime-agent-1" {
		t.Fatalf("container name is not scope isolated: %q", spec.Name)
	}
	if spec.Mounts["/workspace"].Source != "antnest-test-controller-workspace-agent-1" {
		t.Fatalf("workspace mount is not scope isolated: %+v", spec.Mounts)
	}
	if spec.Labels[labelScope] != "test-controller" {
		t.Fatalf("scope label missing: %+v", spec.Labels)
	}
}

func TestScopesIsolateTheSameAgentWithoutTouchingForeignLegacy(t *testing.T) {
	engine := newScopedEngine("scope-a")
	foreign := legacyContainer("agent-1", 3, "scope-b", "sha256:"+digest64('b'), true)
	engine.containers[foreign.Name] = foreign
	engine.byID[foreign.ID] = foreign.Name
	scopedWorkspace(engine, "scope-a", "agent-1")
	driver := scopedDriver(t, engine, "scope-a")
	digest, err := driver.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	outcome := driver.Create(context.Background(), testDeployment(), digest)
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("foreign legacy blocked an independent scope create: %+v", outcome)
	}
	if engine.createdSpecs[0].Name != "antnest-scope-a-runtime-agent-1" {
		t.Fatalf("foreign legacy was adopted by another scope: %+v", engine.createdSpecs[0])
	}
	if engine.containers[containerName("agent-1")].Labels[labelScope] != "scope-b" || len(engine.renamed) != 0 {
		t.Fatal("foreign legacy container was mutated")
	}
}

func digest64(b byte) string {
	return strings.Repeat(string(b), 64)
}

func TestReadyMigratesOwnedLegacyRuntimeOnly(t *testing.T) {
	engine := newScopedEngine("test-controller")
	own := legacyContainer("agent-1", 7, "test-controller", testDigest, false)
	foreign := legacyContainer("agent-9", 2, "scope-b", "sha256:"+digest64('c'), false)
	engine.containers[own.Name] = own
	engine.byID[own.ID] = own.Name
	engine.containers[foreign.Name] = foreign
	engine.byID[foreign.ID] = foreign.Name
	driver := scopedDriver(t, engine, "test-controller")

	if err := driver.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(engine.renamed) != 1 || engine.renamed[0][1] != "antnest-test-controller-runtime-agent-1" {
		t.Fatalf("legacy migration renamed the wrong resources: %+v", engine.renamed)
	}
	migrated := engine.containers["antnest-test-controller-runtime-agent-1"]
	if migrated == nil || migrated.Labels[labelSpecDigest] != testDigest || migrated.Labels[labelGeneration] != "7" {
		t.Fatalf("rename lost managed labels: %+v", migrated)
	}
	if engine.containers[containerName("agent-9")].Labels[labelScope] != "scope-b" {
		t.Fatal("foreign legacy was renamed")
	}
}

func TestReadyReportsLegacyRenameConflictsAndFailures(t *testing.T) {
	for _, test := range []struct {
		name    string
		prepare func(*scopedEngine)
	}{
		{name: "scoped name already present", prepare: func(e *scopedEngine) {
			existing := scopedContainer("agent-1", 7, "test-controller", testDigest, true)
			e.containers[existing.Name] = existing
			e.byID[existing.ID] = existing.Name
		}},
		{name: "rename failure", prepare: func(e *scopedEngine) {
			e.renameErr = errors.New("daemon refused")
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := newScopedEngine("test-controller")
			own := legacyContainer("agent-1", 7, "test-controller", testDigest, false)
			engine.containers[own.Name] = own
			engine.byID[own.ID] = own.Name
			test.prepare(engine)
			driver := scopedDriver(t, engine, "test-controller")
			if err := driver.Ready(context.Background()); err == nil {
				t.Fatal("migration conflict was silently replaced")
			}
			if engine.containers[containerName("agent-1")] == nil {
				t.Fatal("conflict removed the legacy container")
			}
		})
	}
}

func TestInspectAndDeleteAdoptOwnedLegacyOnly(t *testing.T) {
	engine := newScopedEngine("test-controller")
	own := legacyContainer("agent-1", 7, "test-controller", testDigest, true)
	foreign := legacyContainer("agent-2", 7, "other-scope", "sha256:"+digest64('d'), true)
	engine.containers[own.Name] = own
	engine.byID[own.ID] = own.Name
	engine.containers[foreign.Name] = foreign
	engine.byID[foreign.ID] = foreign.Name
	driver := scopedDriver(t, engine, "test-controller")

	inspection, err := driver.Inspect(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7})
	if err != nil || inspection.PlatformPhase != deployment.PhaseRunning {
		t.Fatalf("owned legacy inspection: %+v err=%v", inspection, err)
	}
	missing, err := driver.Inspect(context.Background(), deployment.Key{AgentID: "agent-3", Generation: 1})
	if err != nil || missing.PlatformPhase != deployment.PhaseAbsent {
		t.Fatalf("absent Agent inspection: %+v err=%v", missing, err)
	}
	outcome := driver.Delete(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, testDigest)
	if outcome.State != deployment.EffectCompleted || engine.containers[containerName("agent-1")] != nil {
		t.Fatalf("legacy delete: %+v", outcome)
	}
	if engine.containers[containerName("agent-2")].Labels[labelScope] != "other-scope" {
		t.Fatal("foreign legacy was deleted")
	}
}

func TestScopedNameWithMismatchedLabelsFailsClosed(t *testing.T) {
	engine := newScopedEngine("test-controller")
	foreign := scopedContainer("agent-1", 7, "test-controller", testDigest, true)
	foreign.Labels[labelScope] = "other-scope"
	engine.containers[foreign.Name] = foreign
	engine.byID[foreign.ID] = foreign.Name
	driver := scopedDriver(t, engine, "test-controller")

	if _, err := driver.Inspect(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}); !errors.Is(err, deployment.ErrIdentityConflict) {
		t.Fatalf("foreign scoped-name container was not a closed conflict: %v", err)
	}
	scopedWorkspace(engine, "test-controller", "agent-1")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_drift" {
		t.Fatalf("foreign scoped-name container allowed a create: %+v", outcome)
	}
}

func TestLegacyWorkspaceFallbackUsesOwnedVolumeWithoutShadow(t *testing.T) {
	engine := newScopedEngine("test-controller")
	legacyName := workspaceVolume("agent-1")
	engine.volumes[legacyName] = Volume{Name: legacyName, Labels: map[string]string{
		labelManaged: "workspace", labelScope: "test-controller", labelAgentID: "agent-1",
	}}
	driver := scopedDriver(t, engine, "test-controller")

	if outcome := driver.EnsureStorage(context.Background(), "agent-1"); outcome.State != deployment.EffectCompleted {
		t.Fatalf("owned legacy workspace was not adopted: %+v", outcome)
	}
	if _, ok := engine.volumes[workspaceVolumeName("test-controller", "agent-1")]; ok {
		t.Fatal("empty scoped volume shadowed the owned legacy workspace")
	}
	digest, err := driver.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	outcome := driver.Create(context.Background(), testDeployment(), digest)
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("create with legacy workspace: %+v", outcome)
	}
	if engine.createdSpecs[0].Mounts["/workspace"].Source != legacyName {
		t.Fatalf("new container did not mount the existing legacy volume: %+v", engine.createdSpecs[0].Mounts)
	}
	if outcome := driver.VerifyStorage(context.Background(), "agent-1"); outcome.State != deployment.EffectCompleted {
		t.Fatalf("legacy workspace verify: %+v", outcome)
	}
}

func TestDeleteStorageRemovesBothOwnedAndLeavesForeignLegacy(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedName := workspaceVolumeName("test-controller", "agent-1")
	legacyName := workspaceVolume("agent-1")
	for _, name := range []string{scopedName, legacyName} {
		engine.volumes[name] = Volume{Name: name, Labels: map[string]string{
			labelManaged: "workspace", labelScope: "test-controller", labelAgentID: "agent-1",
		}}
	}
	engine.volumes[workspaceVolume("agent-2")] = Volume{Name: workspaceVolume("agent-2"), Labels: map[string]string{
		labelManaged: "workspace", labelScope: "other-scope", labelAgentID: "agent-1",
	}}
	driver := scopedDriver(t, engine, "test-controller")

	outcome := driver.DeleteStorage(context.Background(), "agent-1")
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("delete storage: %+v", outcome)
	}
	if _, ok := engine.volumes[scopedName]; ok {
		t.Fatal("owned scoped workspace leaked")
	}
	if _, ok := engine.volumes[legacyName]; ok {
		t.Fatal("owned legacy workspace leaked")
	}
	if _, ok := engine.volumes[workspaceVolume("agent-2")]; !ok {
		t.Fatal("foreign legacy workspace was removed")
	}
}

func TestDeploymentDigestStaysCanonicalWithLegacyReplayAcceptance(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	driver := scopedDriver(t, engine, "test-controller")
	canonical, err := driver.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := driver.legacyDeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	if canonical == legacy {
		t.Fatal("scoped and legacy digests collide")
	}
	outcome := driver.Create(context.Background(), testDeployment(), legacy)
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("in-flight legacy operation was rejected: %+v", outcome)
	}
	if engine.createdSpecs[0].Name != "antnest-test-controller-runtime-agent-1" || engine.createdSpecs[0].Labels[labelSpecDigest] != legacy {
		t.Fatalf("legacy replay did not persist its own digest on scoped resources: %+v", engine.createdSpecs[0])
	}
	if other := driver.Create(context.Background(), testDeployment(), "sha256:0000000000000000000000000000000000000000000000000000000000000000"); other.Code != "invalid_request" {
		t.Fatalf("arbitrary digest was accepted: %+v", other)
	}
}

func TestListMigratesOwnedLegacyRuntimeAndRetriesAfterFailure(t *testing.T) {
	engine := newScopedEngine("test-controller")
	own := legacyContainer("agent-1", 7, "test-controller", testDigest, false)
	engine.containers[own.Name] = own
	engine.byID[own.ID] = own.Name
	driver := scopedDriver(t, engine, "test-controller")

	engine.renameErr = errors.New("daemon busy")
	if _, err := driver.List(context.Background()); err == nil {
		t.Fatal("transient rename failure was hidden")
	}
	if engine.containers[containerName("agent-1")] == nil {
		t.Fatal("failed migration discarded the legacy container")
	}
	engine.renameErr = nil
	inspections, err := driver.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	migrated := engine.containers["antnest-test-controller-runtime-agent-1"]
	if migrated == nil || len(inspections) != 1 || inspections[0].AgentID != "agent-1" {
		t.Fatalf("migration retry did not converge: renamed=%v inspections=%+v", migrated != nil, inspections)
	}
}
