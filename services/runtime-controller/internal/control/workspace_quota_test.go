package control

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

type quotaPlatform struct {
	*lifecyclePlatform
	enforced         bool
	verifyOutcome    deployment.EffectOutcome
	lastVerifyLimits []deployment.ResourceLimits
}

func (p *quotaPlatform) DiskQuotaEnforced() bool { return p.enforced }

func (p *quotaPlatform) Watch(
	context.Context, time.Time, func(context.Context) error, func(context.Context, deployment.Observation) error,
) error {
	return nil
}

func TestStatusReportsQuotaThroughTheTelemetryWrapper(t *testing.T) {
	repository := newLifecycleRepository()
	platform := &quotaPlatform{lifecyclePlatform: newLifecyclePlatform(), enforced: true}
	wrapped, err := telemetry.ObservePlatform(platform, slog.New(slog.NewTextHandler(io.Discard, nil)), "docker")
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(repository, repository, lifecycleObservationReadiness{}, wrapped, lifecycleVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	status, err := service.Status(context.Background())
	if err != nil || !status.DiskQuotaEnforced {
		t.Fatalf("quota capability must survive the telemetry wrapper: %+v %v", status, err)
	}
}

func (p *quotaPlatform) VerifyStorage(
	_ context.Context, _ string, limits ...deployment.ResourceLimits,
) deployment.EffectOutcome {
	p.verifyStorageCalls++
	p.lastVerifyLimits = limits
	return p.verifyOutcome
}

func TestStatusReportsDiskQuotaCapability(t *testing.T) {
	repository := newLifecycleRepository()
	platform := &quotaPlatform{lifecyclePlatform: newLifecyclePlatform()}
	service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, lifecycleVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	status, err := service.Status(context.Background())
	if err != nil || status.DiskQuotaEnforced {
		t.Fatalf("unbounded local storage must report disk_quota_enforced=false: %+v %v", status, err)
	}
	platform.enforced = true
	status, err = service.Status(context.Background())
	if err != nil || !status.DiskQuotaEnforced {
		t.Fatalf("configured quota backend must report disk_quota_enforced=true: %+v %v", status, err)
	}
}

func TestUpdateRejectsWorkspaceMismatchWithoutDestructiveEffect(t *testing.T) {
	repository := newLifecycleRepository()
	platform := &quotaPlatform{
		lifecyclePlatform: newLifecyclePlatform(),
		verifyOutcome: deployment.EffectOutcome{
			State: deployment.EffectNotStarted, Code: "storage_ownership_conflict",
			Detail: "workspace byte limit differs",
		},
	}
	service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, lifecycleVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	configuration := lifecycleConfiguration()
	created, err := service.InitializeRuntime(context.Background(), "init-1", "agent-1", configuration)
	if err != nil || created.State != deployment.OperationCompleted {
		t.Fatalf("initialize: %+v %v", created, err)
	}
	deletes, creates, storageDeletes := platform.deleteCalls, platform.createCalls, platform.deleteStorageCalls
	updated, err := service.UpdateRuntime(context.Background(), "update-1", "agent-1", created.RuntimeRevision, configuration)
	if err != nil {
		t.Fatal(err)
	}
	if updated.State == deployment.OperationCompleted || updated.ErrorCode != "storage_ownership_conflict" {
		t.Fatalf("workspace mismatch must reject the update: %+v", updated)
	}
	if platform.deleteCalls != deletes || platform.createCalls != creates || platform.deleteStorageCalls != storageDeletes {
		t.Fatalf("rejected update must keep the source Runtime intact: %+v", platform)
	}
	if len(platform.lastVerifyLimits) != 1 {
		t.Fatalf("update preflight did not forward the requested limits: %+v", platform.lastVerifyLimits)
	}
}
