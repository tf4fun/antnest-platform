package rpc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/observation"
	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
)

type legacyInventoryStub struct {
	called bool
}

func (stub *legacyInventoryStub) Inventory(context.Context) (platformdocker.LegacySystemSkillsInventory, error) {
	stub.called = true
	return platformdocker.LegacySystemSkillsInventory{VolumeName: "legacy", InventoryDigest: "sha256:digest", Entries: []platformdocker.LegacyInventoryEntry{}, References: []platformdocker.LegacyInventoryReference{}}, nil
}

func TestLegacyInventoryRouteIsReadOnly(t *testing.T) {
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	stub := &legacyInventoryStub{}
	handler.SetLegacyInventory(stub)
	request := httptest.NewRequest(http.MethodGet, "/internal/legacy-system-skills/inventory", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !stub.called || response.Body.String() != `{"volume_name":"legacy","inventory_digest":"sha256:digest","entries":[],"references":[]}`+"\n" {
		t.Fatalf("legacy inventory response=%d %s", response.Code, response.Body.String())
	}
	post := httptest.NewRequest(http.MethodPost, "/internal/legacy-system-skills/inventory", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("legacy inventory accepted mutation: %d", response.Code)
	}
}
