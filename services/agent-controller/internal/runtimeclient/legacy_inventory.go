package runtimeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const maximumLegacyInventoryResponseBytes = 64 << 20

var legacyBackupRefPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func (client *Client) GetLegacySkillBackup(ctx context.Context, backupRef string) (ports.LegacySkillBackupReceipt, error) {
	if !legacyBackupRefPattern.MatchString(backupRef) {
		return ports.LegacySkillBackupReceipt{}, dependencyFailure("invalid_request", false)
	}
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	endpoint := *client.baseURL
	endpoint.Path = "/internal/legacy-system-skills/backups/" + backupRef
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ports.LegacySkillBackupReceipt{}, dependencyFailure("invalid_request", false, err)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.LegacySkillBackupReceipt{}, dependencyFailure("control_plane_unavailable", true, err)
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maximumLegacyInventoryResponseBytes+1))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || len(body) > maximumLegacyInventoryResponseBytes {
		return ports.LegacySkillBackupReceipt{}, dependencyFailure("invalid_response", true, readErr, closeErr)
	}
	if response.StatusCode != http.StatusOK {
		return ports.LegacySkillBackupReceipt{}, decodeFailure(body, response.StatusCode)
	}
	var receipt ports.LegacySkillBackupReceipt
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return ports.LegacySkillBackupReceipt{}, dependencyFailure("invalid_response", true, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ports.LegacySkillBackupReceipt{}, dependencyFailure("invalid_response", true)
	}
	if receipt.BackupRef != backupRef || !skillSetDigestPattern.MatchString(receipt.ArchiveDigest) || !skillSetDigestPattern.MatchString(receipt.ManifestDigest) || receipt.CreatedAt.IsZero() ||
		validateLegacyInventory(ports.LegacySkillInventory{VolumeName: receipt.VolumeName, InventoryDigest: receipt.InventoryDigest, Entries: receipt.Entries, References: []ports.LegacySkillInventoryReference{}}) != nil {
		return ports.LegacySkillBackupReceipt{}, dependencyFailure("invalid_response", true)
	}
	return receipt, nil
}

func (client *Client) GetLegacySkillInventory(ctx context.Context) (ports.LegacySkillInventory, error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	endpoint := *client.baseURL
	endpoint.Path = "/internal/legacy-system-skills/inventory"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ports.LegacySkillInventory{}, dependencyFailure("invalid_request", false, err)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.LegacySkillInventory{}, dependencyFailure("control_plane_unavailable", true, err)
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maximumLegacyInventoryResponseBytes+1))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || len(body) > maximumLegacyInventoryResponseBytes {
		return ports.LegacySkillInventory{}, dependencyFailure("invalid_response", true, readErr, closeErr)
	}
	if response.StatusCode != http.StatusOK {
		return ports.LegacySkillInventory{}, decodeFailure(body, response.StatusCode)
	}
	var inventory ports.LegacySkillInventory
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&inventory); err != nil {
		return ports.LegacySkillInventory{}, dependencyFailure("invalid_response", true, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ports.LegacySkillInventory{}, dependencyFailure("invalid_response", true)
	}
	if err := validateLegacyInventory(inventory); err != nil {
		return ports.LegacySkillInventory{}, dependencyFailure("invalid_response", true, err)
	}
	return inventory, nil
}

func validateLegacyInventory(value ports.LegacySkillInventory) error {
	if len(value.VolumeName) == 0 || len(value.VolumeName) > 255 || strings.Contains(value.VolumeName, "/") || !skillSetDigestPattern.MatchString(value.InventoryDigest) || value.Entries == nil || value.References == nil || len(value.Entries) > 10_000 {
		return fmt.Errorf("legacy inventory identity or bounds differ")
	}
	var previous string
	var total int64
	for index, entry := range value.Entries {
		if !utf8.ValidString(entry.Path) || entry.Path == "" || len(entry.Path) > 4096 || strings.HasPrefix(entry.Path, "/") || path.Clean(entry.Path) != entry.Path || entry.Path == ".." || strings.HasPrefix(entry.Path, "../") || entry.Mode > 0777 || entry.Size < 0 || index > 0 && entry.Path <= previous {
			return fmt.Errorf("legacy inventory entry path or metadata differs")
		}
		if !oneOf(entry.Kind, "regular", "directory", "symlink", "unsupported") {
			return fmt.Errorf("legacy inventory entry kind differs")
		}
		if entry.Kind == "regular" {
			total += entry.Size
			if !skillSetDigestPattern.MatchString(entry.Digest) || total > 1<<30 {
				return fmt.Errorf("legacy inventory file digest or budget differs")
			}
		} else if entry.Size != 0 || entry.Kind == "symlink" && !skillSetDigestPattern.MatchString(entry.Digest) || entry.Kind != "symlink" && entry.Digest != "" {
			return fmt.Errorf("legacy inventory non-file identity differs")
		}
		previous = entry.Path
	}
	previous = ""
	for index, reference := range value.References {
		if reference.ContainerID == "" || index > 0 && reference.ContainerID <= previous || reference.Managed && reference.AgentID == "" || !reference.Managed && reference.AgentID != "" {
			return fmt.Errorf("legacy inventory reference identity differs")
		}
		previous = reference.ContainerID
	}
	return nil
}

var _ ports.LegacySkillInventoryClient = (*Client)(nil)
var _ ports.LegacySkillBackupClient = (*Client)(nil)
