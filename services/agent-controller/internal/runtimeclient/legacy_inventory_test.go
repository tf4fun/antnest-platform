package runtimeclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLegacyInventoryClientReadsCompleteRCIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/internal/legacy-system-skills/inventory" {
			t.Errorf("wrong inventory request: %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"volume_name":"legacy","inventory_digest":"sha256:` + strings.Repeat("a", 64) + `","entries":[{"path":"note.txt","kind":"regular","mode":292,"size":4,"digest":"sha256:` + strings.Repeat("b", 64) + `"}],"references":[{"container_id":"docker-id","running":false,"managed":false}]}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	inventory, err := client.GetLegacySkillInventory(context.Background())
	if err != nil || inventory.VolumeName != "legacy" || len(inventory.Entries) != 1 || len(inventory.References) != 1 {
		t.Fatalf("inventory=%+v, %v", inventory, err)
	}
}

func TestLegacyInventoryClientRejectsIncompleteOrMalformedResponses(t *testing.T) {
	for _, body := range []string{
		`{"volume_name":"legacy","inventory_digest":"sha256:bad","entries":[],"references":[]}`,
		`{"volume_name":"legacy","inventory_digest":"sha256:` + strings.Repeat("a", 64) + `","entries":null,"references":[]}`,
		`{"volume_name":"legacy","inventory_digest":"sha256:` + strings.Repeat("a", 64) + `","entries":[{"path":"../escape","kind":"regular","mode":292,"size":1,"digest":"sha256:` + strings.Repeat("b", 64) + `"}],"references":[]}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write([]byte(body)) }))
		client, err := New(server.URL, time.Second, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.GetLegacySkillInventory(context.Background()); err == nil {
			t.Fatalf("invalid inventory accepted: %s", body)
		}
		server.Close()
	}
}

func TestLegacyBackupClientRequiresCompleteVerifiedReceipt(t *testing.T) {
	body := `{"backup_ref":"backup-1","volume_name":"legacy","inventory_digest":"sha256:` + strings.Repeat("a", 64) + `","entries":[],"archive_digest":"sha256:` + strings.Repeat("b", 64) + `","manifest_digest":"sha256:` + strings.Repeat("c", 64) + `","created_at":"2026-09-28T00:00:00Z"}`
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/internal/legacy-system-skills/backups/backup-1" {
			t.Errorf("wrong backup request: %s %s", request.Method, request.URL.Path)
		}
		_, _ = response.Write([]byte(body))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := client.GetLegacySkillBackup(context.Background(), "backup-1")
	if err != nil || receipt.BackupRef != "backup-1" || len(receipt.Entries) != 0 {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if _, err := client.GetLegacySkillBackup(context.Background(), "../escape"); err == nil {
		t.Fatal("invalid reference accepted")
	}
}

func TestLegacyBackupClientRejectsMalformedAndMissingReceipts(t *testing.T) {
	for _, body := range []string{
		`{"backup_ref":"wrong","volume_name":"legacy","inventory_digest":"sha256:` + strings.Repeat("a", 64) + `","entries":[],"archive_digest":"sha256:` + strings.Repeat("b", 64) + `","manifest_digest":"sha256:` + strings.Repeat("c", 64) + `","created_at":"2026-09-28T00:00:00Z"}`,
		`{"backup_ref":"backup-1","volume_name":"legacy","inventory_digest":"sha256:` + strings.Repeat("a", 64) + `","entries":null,"archive_digest":"sha256:` + strings.Repeat("b", 64) + `","manifest_digest":"sha256:` + strings.Repeat("c", 64) + `","created_at":"2026-09-28T00:00:00Z"}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write([]byte(body)) }))
		client, err := New(server.URL, time.Second, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.GetLegacySkillBackup(context.Background(), "backup-1"); err == nil {
			t.Fatalf("malformed receipt accepted: %s", body)
		}
		server.Close()
	}
}
