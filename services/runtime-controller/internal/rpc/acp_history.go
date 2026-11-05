package rpc

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/apierror"
)

func (h *Handler) historyAcpIncarnations(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > acpIncarnationRequestBytes {
		writeAcpIncarnationError(w, apierror.RequestTooLarge)
		return
	}
	var raw []byte
	var err error
	if r.Body != nil {
		raw, err = io.ReadAll(io.LimitReader(r.Body, acpIncarnationRequestBytes+1))
	}
	if acpIncarnationTimedOut(r.Context(), err) {
		writeAcpIncarnationError(w, apierror.DeadlineExceeded)
		return
	}
	if len(raw) > acpIncarnationRequestBytes {
		writeAcpIncarnationError(w, apierror.RequestTooLarge)
		return
	}
	var wire struct {
		MemberID string          `json:"member_id"`
		Cursor   json.RawMessage `json:"cursor"`
	}
	if err != nil || serviceauth.DecodeObject(raw, &wire) != nil || len(wire.Cursor) == 0 {
		writeAcpIncarnationError(w, apierror.InvalidRequest)
		return
	}
	input := acpincarnation.HistoryRequest{MemberID: wire.MemberID}
	if !bytes.Equal(bytes.TrimSpace(wire.Cursor), []byte("null")) {
		var cursor acpincarnation.HistoryCursor
		if serviceauth.DecodeObject(wire.Cursor, &cursor) != nil {
			writeAcpIncarnationError(w, apierror.InvalidRequest)
			return
		}
		input.Cursor = &cursor
	}
	if !acpincarnation.ValidHistoryRequest(input) {
		writeAcpIncarnationError(w, apierror.InvalidRequest)
		return
	}
	page, err := h.incarnations.History(r.Context(), input)
	if err != nil || r.Context().Err() != nil {
		writeAcpIncarnationFailure(w, r.Context(), err, true)
		return
	}
	if !acpincarnation.ValidHistoryPage(input, page) {
		writeAcpIncarnationError(w, apierror.InternalError)
		return
	}
	encoded, err := json.Marshal(page)
	if err != nil || len(encoded) > 32768 {
		writeAcpIncarnationError(w, apierror.InternalError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
}
