package rpc

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
)

type LegacyBackupService interface {
	Backup(context.Context, string, string) (platformdocker.LegacyBackupReceipt, error)
	Receipt(context.Context, string) (platformdocker.LegacyBackupReceipt, error)
}

type legacyBackupRequest struct {
	ExpectedInventoryDigest string `json:"expected_inventory_digest"`
}

var legacyBackupRequestID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var legacyBackupExpectedDigest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func (h *Handler) createLegacySystemSkillsBackup(response http.ResponseWriter, request *http.Request) {
	if h.legacyBackup == nil {
		writeJSON(response, http.StatusServiceUnavailable, errorResponse{Code: "legacy_backup_unavailable", Message: "Legacy system Skill backup is unavailable", Retryable: true})
		return
	}
	requestID, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var input legacyBackupRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	if !legacyBackupRequestID.MatchString(requestID) || !legacyBackupExpectedDigest.MatchString(input.ExpectedInventoryDigest) {
		writeJSON(response, http.StatusBadRequest, errorResponse{Code: "invalid_request", Message: "Legacy backup identity is invalid", Retryable: false})
		return
	}
	receipt, err := h.legacyBackup.Backup(request.Context(), requestID, input.ExpectedInventoryDigest)
	if err != nil {
		if errors.Is(err, platformdocker.ErrLegacyInventoryChanged) || errors.Is(err, platformdocker.ErrLegacyBackupConflict) {
			writeJSON(response, http.StatusConflict, errorResponse{Code: "legacy_backup_conflict", Message: "Legacy backup source or request identity changed", Retryable: false})
			return
		}
		writeJSON(response, http.StatusServiceUnavailable, errorResponse{Code: "legacy_backup_unavailable", Message: "Legacy system Skill backup is unavailable", Retryable: true})
		return
	}
	writeJSON(response, http.StatusCreated, receipt)
}

func (h *Handler) getLegacySystemSkillsBackup(response http.ResponseWriter, request *http.Request) {
	backupRef := request.PathValue("backup_ref")
	if !legacyBackupRequestID.MatchString(backupRef) {
		writeJSON(response, http.StatusBadRequest, errorResponse{Code: "invalid_request", Message: "Legacy backup reference is invalid", Retryable: false})
		return
	}
	if h.legacyBackup == nil {
		writeJSON(response, http.StatusServiceUnavailable, errorResponse{Code: "legacy_backup_unavailable", Message: "Legacy system Skill backup is unavailable", Retryable: true})
		return
	}
	receipt, err := h.legacyBackup.Receipt(request.Context(), backupRef)
	if err != nil {
		if errors.Is(err, platformdocker.ErrLegacyBackupNotFound) {
			writeJSON(response, http.StatusNotFound, errorResponse{Code: "legacy_backup_not_found", Message: "Legacy backup receipt was not found", Retryable: false})
			return
		}
		writeJSON(response, http.StatusServiceUnavailable, errorResponse{Code: "legacy_backup_unavailable", Message: "Legacy system Skill backup is unavailable", Retryable: true})
		return
	}
	writeJSON(response, http.StatusOK, receipt)
}
