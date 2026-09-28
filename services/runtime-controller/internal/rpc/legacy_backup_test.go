package rpc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/observation"
	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
)

type legacyBackupStub struct {
	requestID string
	digest    string
	calls     int
}

func (stub *legacyBackupStub) Receipt(_ context.Context, backupRef string) (platformdocker.LegacyBackupReceipt, error) {
	stub.requestID = backupRef
	if backupRef == "missing" {
		return platformdocker.LegacyBackupReceipt{}, platformdocker.ErrLegacyBackupNotFound
	}
	return platformdocker.LegacyBackupReceipt{BackupRef: backupRef, VolumeName: "legacy", ManifestDigest: "sha256:" + strings.Repeat("c", 64)}, nil
}

func TestLegacyBackupReadRouteReturnsVerifiedReceiptAndRejectsUnknownID(t *testing.T) {
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	stub := &legacyBackupStub{}
	handler.SetLegacyBackup(stub)
	for _, item := range []struct {
		path   string
		status int
	}{
		{"/internal/legacy-system-skills/backups/backup-1", http.StatusOK},
		{"/internal/legacy-system-skills/backups/missing", http.StatusNotFound},
		{"/internal/legacy-system-skills/backups/bad%20id", http.StatusBadRequest},
	} {
		request := httptest.NewRequest(http.MethodGet, item.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != item.status {
			t.Fatalf("GET %s: %d %s", item.path, response.Code, response.Body.String())
		}
	}
}

func (stub *legacyBackupStub) Backup(_ context.Context, requestID, digest string) (platformdocker.LegacyBackupReceipt, error) {
	stub.calls++
	stub.requestID = requestID
	stub.digest = digest
	return platformdocker.LegacyBackupReceipt{BackupRef: requestID, VolumeName: "legacy", InventoryDigest: digest,
		Entries: []platformdocker.LegacyInventoryEntry{}, ArchiveDigest: "sha256:" + strings.Repeat("b", 64), ManifestDigest: "sha256:" + strings.Repeat("c", 64), CreatedAt: time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)}, nil
}

func TestLegacyBackupRouteRequiresIdentityAndReturnsVerifiedReceipt(t *testing.T) {
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	stub := &legacyBackupStub{}
	handler.SetLegacyBackup(stub)
	body := `{"expected_inventory_digest":"sha256:` + strings.Repeat("a", 64) + `"}`
	request := httptest.NewRequest(http.MethodPost, "/internal/legacy-system-skills/backups", strings.NewReader(body))
	request.Header.Set("Idempotency-Key", "backup-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || stub.calls != 1 || stub.requestID != "backup-1" || stub.digest != "sha256:"+strings.Repeat("a", 64) || !strings.Contains(response.Body.String(), `"manifest_digest":"sha256:`) {
		t.Fatalf("backup response=%d %s stub=%+v", response.Code, response.Body.String(), stub)
	}
	missing := httptest.NewRequest(http.MethodPost, "/internal/legacy-system-skills/backups", strings.NewReader(body))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, missing)
	if response.Code != http.StatusBadRequest || stub.calls != 1 {
		t.Fatalf("missing idempotency key accepted: %d %s", response.Code, response.Body.String())
	}
	malformed := httptest.NewRequest(http.MethodPost, "/internal/legacy-system-skills/backups", strings.NewReader(`{"expected_inventory_digest":"wrong"}`))
	malformed.Header.Set("Idempotency-Key", "backup-2")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, malformed)
	if response.Code != http.StatusBadRequest || stub.calls != 1 {
		t.Fatalf("invalid inventory digest accepted: %d %s", response.Code, response.Body.String())
	}
}
