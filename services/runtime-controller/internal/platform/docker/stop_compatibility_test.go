package docker

import (
	"context"
	"net/http"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type legacyStopEngine struct {
	Engine
	stopCalls int
}

func (e *legacyStopEngine) StopContainer(_ context.Context, _ string) error {
	e.stopCalls++
	if base, ok := e.Engine.(*fakeEngine); ok && base.container != nil {
		base.container.Running = false
		base.container.Status = "exited"
	}
	return nil
}

var _ Engine = &legacyStopEngine{}

func TestDeleteUsesDefaultGraceThroughLegacyStopSignature(t *testing.T) {
	base := newFakeEngine()
	base.container = exactContainer()
	base.container.Running = true
	legacy := &legacyStopEngine{Engine: base}
	driver, err := NewDriver(legacy, testDriverConfig())
	if err != nil {
		t.Fatal(err)
	}

	outcome := driver.Delete(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, testDigest)
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("delete through the legacy stop signature: %+v", outcome)
	}
	if legacy.stopCalls != 1 {
		t.Fatalf("original two-argument stop was bypassed %d times", legacy.stopCalls)
	}
}

func TestConfiguredGraceRejectsLegacyEngineDecorator(t *testing.T) {
	base := newFakeEngine()
	base.container = exactContainer()
	base.container.Running = true
	legacy := &legacyStopEngine{Engine: base}
	config := testDriverConfig()
	config.StopGraceSeconds = 45
	driver, err := NewDriver(legacy, config)
	if err != nil {
		t.Fatal(err)
	}

	outcome := driver.Delete(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, testDigest)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "platform_unavailable" {
		t.Fatalf("a legacy decorator must fail closed for a non-default grace: %+v", outcome)
	}
	if legacy.stopCalls != 0 || base.removeCalls != 0 {
		t.Fatalf("rejection must happen before stop/remove: legacy=%d remove=%d", legacy.stopCalls, base.removeCalls)
	}
}

func TestClientStopContainerDefaultSendsTwentySeconds(t *testing.T) {
	var query string
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		query = request.URL.RawQuery
		return responseWith(http.StatusNoContent, ""), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.StopContainer(context.Background(), "container-1"); err != nil {
		t.Fatal(err)
	}
	if query != "t=20" {
		t.Fatalf("default stop query = %q, want t=20", query)
	}
}
