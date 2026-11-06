package rpc

import (
	"encoding/json"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func pageCursor(limit *int, canonical, legacy json.RawMessage) (string, error) {
	if limit == nil || *limit < 1 || *limit > 100 {
		return "", domain.InvalidArgument("limit must be 1–100")
	}
	if canonical != nil && legacy != nil {
		return "", domain.InvalidArgument("send only one cursor form")
	}
	raw := canonical
	if raw == nil {
		raw = legacy
	}
	if raw == nil {
		return "", nil
	}
	var cursor string
	if err := json.Unmarshal(raw, &cursor); err != nil || len(cursor) == 0 || len(cursor) > 4096 || !domain.ValidID(cursor) {
		return "", domain.InvalidArgument("cursor must be a public reference")
	}
	return cursor, nil
}
