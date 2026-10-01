package docker

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

type preparedGateStub struct {
	calls int
	err   error
}

type preparedGateSequence struct {
	calls     int
	failAfter int
}

func (g *preparedGateSequence) VerifyRuntimeMount(context.Context, skillset.SetKey, string, string) error {
	g.calls++
	if g.failAfter > 0 && g.calls >= g.failAfter {
		return errors.New("mounted Skill changed after Docker start")
	}
	return nil
}

type preparedGateFunc func()

func (g preparedGateFunc) VerifyRuntimeMount(context.Context, skillset.SetKey, string, string) error {
	g()
	return errors.New("rejected Skill mount")
}

func (g *preparedGateStub) VerifyRuntimeMount(context.Context, skillset.SetKey, string, string) error {
	g.calls++
	return g.err
}

func TestPreparedSkillRuntimeStartsOnlyAfterActualMountGate(t *testing.T) {
	for _, broken := range []bool{false, true} {
		engine := newFakeEngine()
		gate := &preparedGateStub{}
		if broken {
			gate.err = errors.New("empty auto-created volume")
		}
		driver, err := NewDriver(engine, Config{ControllerScope: "test-controller", ManagementNetwork: "antnest-runtime-management", SystemSkillsVolume: "antnest-system-skills", SkillMountGate: gate})
		if err != nil {
			t.Fatal(err)
		}
		value := testDeployment()
		org := "org_00000000000000000000000000000000"
		setDigest, err := skillset.Digest(org, 1, nil)
		if err != nil {
			t.Fatal(err)
		}
		key := skillset.SetKey{Scope: "test-controller", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: setDigest, LayoutVersion: 1, Materialization: 1}
		volumeName, err := key.VolumeName()
		if err != nil {
			t.Fatal(err)
		}
		value.PreparedSkills = &skillset.PreparedReference{Scope: key.Scope, OrganizationID: org, AgentID: "agent-1", SkillSetDigest: setDigest, LayoutVersion: 1, ReferenceID: "psr_11111111111111111111111111111111", SystemSkills: []skillset.FrozenSkill{}}
		value.PreparedMaterialization = &skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: volumeName, ManifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
		engine.volumes[volumeName] = Volume{Name: volumeName, Labels: skillVolumeLabels(key)}
		digest, err := driver.DeploymentDigest(value)
		if err != nil {
			t.Fatal(err)
		}
		outcome := driver.Create(context.Background(), value, digest)
		if gate.calls != 1 || engine.created.Mounts["/skills"].Source != volumeName || !engine.created.Mounts["/skills"].NoCopy {
			t.Fatalf("prepared mount omitted: outcome=%+v gate=%+v spec=%+v", outcome, gate, engine.created)
		}
		if broken && (outcome.Code != "skill_mount_verification_failed" || engine.startCalls != 0) {
			t.Fatalf("bad mount started: %+v starts=%d", outcome, engine.startCalls)
		}
		if broken && (outcome.State != deployment.EffectUnknown || engine.removeCalls != 1 || engine.container != nil) {
			t.Fatalf("rejected pre-start Runtime candidate was retained: %+v removals=%d container=%+v", outcome, engine.removeCalls, engine.container)
		}
		if !broken && (outcome.State != deployment.EffectCompleted || engine.startCalls != 1) {
			t.Fatalf("valid mount did not start: %+v starts=%d", outcome, engine.startCalls)
		}
		if !broken {
			gate.err = errors.New("mounted manifest changed after startup")
			replayed := driver.Create(context.Background(), value, digest)
			if replayed.Code != "skill_mount_verification_failed" || replayed.State != deployment.EffectUnknown || gate.calls != 2 {
				t.Fatalf("running target bypassed mount recheck: %+v gate=%+v", replayed, gate)
			}
		}
	}
}

func TestRejectedSkillCandidateCleanupKeepsChangedOrRunningContainer(t *testing.T) {
	for _, change := range []string{"changed identity", "started externally"} {
		t.Run(change, func(t *testing.T) {
			engine := newFakeEngine()
			org := "org_00000000000000000000000000000000"
			setDigest, err := skillset.Digest(org, 1, nil)
			if err != nil {
				t.Fatal(err)
			}
			key := skillset.SetKey{Scope: "test-controller", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: setDigest, LayoutVersion: 1, Materialization: 1}
			volumeName, err := key.VolumeName()
			if err != nil {
				t.Fatal(err)
			}
			value := testDeployment()
			value.PreparedSkills = &skillset.PreparedReference{Scope: key.Scope, OrganizationID: org, AgentID: key.AgentID, SkillSetDigest: setDigest, LayoutVersion: 1, ReferenceID: "psr_11111111111111111111111111111111", SystemSkills: []skillset.FrozenSkill{}}
			value.PreparedMaterialization = &skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: volumeName, ManifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
			engine.volumes[volumeName] = Volume{Name: volumeName, Labels: skillVolumeLabels(key)}
			gate := preparedGateFunc(func() {
				if change == "started externally" {
					engine.container.Status, engine.container.Running = "running", true
				} else {
					engine.container.Labels[labelGeneration] = "100"
				}
			})
			driver, err := NewDriver(engine, Config{ControllerScope: key.Scope, ManagementNetwork: "antnest-runtime-management", SystemSkillsVolume: "antnest-system-skills", SkillMountGate: gate})
			if err != nil {
				t.Fatal(err)
			}
			digest, err := driver.DeploymentDigest(value)
			if err != nil {
				t.Fatal(err)
			}
			outcome := driver.Create(context.Background(), value, digest)
			if outcome.State != deployment.EffectUnknown || outcome.Code != "skill_mount_verification_failed" || engine.startCalls != 0 || engine.removeCalls != 0 || engine.container == nil {
				t.Fatalf("changed candidate was removed or accepted: %+v engine=%+v", outcome, engine)
			}
		})
	}
}

func TestPreparedSkillStartResponseLossRechecksRunningMount(t *testing.T) {
	for _, drift := range []bool{false, true} {
		engine := newFakeEngine()
		engine.startErr = Uncertain(errors.New("Docker start response lost"))
		gate := &preparedGateSequence{}
		if drift {
			gate.failAfter = 2
		}
		driver, err := NewDriver(engine, Config{ControllerScope: "test-controller", ManagementNetwork: "antnest-runtime-management", SystemSkillsVolume: "antnest-system-skills", SkillMountGate: gate})
		if err != nil {
			t.Fatal(err)
		}
		value := testDeployment()
		org := "org_00000000000000000000000000000000"
		setDigest, err := skillset.Digest(org, 1, nil)
		if err != nil {
			t.Fatal(err)
		}
		key := skillset.SetKey{Scope: "test-controller", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: setDigest, LayoutVersion: 1, Materialization: 1}
		volumeName, err := key.VolumeName()
		if err != nil {
			t.Fatal(err)
		}
		value.PreparedSkills = &skillset.PreparedReference{Scope: key.Scope, OrganizationID: org, AgentID: key.AgentID, SkillSetDigest: setDigest, LayoutVersion: 1, ReferenceID: "psr_11111111111111111111111111111111", SystemSkills: []skillset.FrozenSkill{}}
		value.PreparedMaterialization = &skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: volumeName, ManifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
		engine.volumes[volumeName] = Volume{Name: volumeName, Labels: skillVolumeLabels(key)}
		digest, err := driver.DeploymentDigest(value)
		if err != nil {
			t.Fatal(err)
		}
		outcome := driver.Create(context.Background(), value, digest)
		if gate.calls != 2 || engine.startCalls != 1 || engine.container == nil || !engine.container.Running {
			t.Fatalf("response-loss recovery skipped running mount verification: outcome=%+v gate=%+v engine=%+v", outcome, gate, engine)
		}
		if drift && (outcome.State != deployment.EffectUnknown || outcome.Code != "skill_mount_verification_failed") {
			t.Fatalf("changed running mount was adopted: %+v", outcome)
		}
		if !drift && outcome.State != deployment.EffectCompleted {
			t.Fatalf("valid running mount did not converge: %+v", outcome)
		}
	}
}
