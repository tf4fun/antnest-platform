package postgres

import (
	"encoding/json"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

// Receipts freeze command results, not credentials or queryable model history.
type modelReceipt struct {
	Configuration domain.ModelProfileRevisionSnapshot `json:"configuration"`
	ConnectionID  string                              `json:"connection_id"`
	ProfileKey    string                              `json:"profile_key"`
	DisplayName   string                              `json:"display_name"`
	Enabled       bool                                `json:"enabled"`
	CreatedAt     time.Time                           `json:"created_at"`
	UpdatedAt     time.Time                           `json:"updated_at"`
}

func encodeModelReceipt(record ports.ModelProfileRecord) ([]byte, error) {
	payload, err := json.Marshal(modelReceipt{
		Configuration: record.Revision.Snapshot(), ConnectionID: record.ProviderConnectionID,
		ProfileKey: record.ProfileKey, DisplayName: record.DisplayName, Enabled: record.Enabled,
		CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("encode model command response: %w", err)
	}
	return payload, nil
}

func decodeModelReceipt(payload []byte) (ports.ModelProfileRecord, error) {
	var response modelReceipt
	if err := json.Unmarshal(payload, &response); err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("decode model command response: %w", err)
	}
	configuration, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(response.Configuration))
	if err != nil {
		return ports.ModelProfileRecord{}, err
	}
	return ports.ModelProfileRecord{
		ProviderConnectionID: response.ConnectionID, ModelProfileID: response.Configuration.ModelProfileID,
		OrganizationID: response.Configuration.OrganizationID, ProfileKey: response.ProfileKey,
		DisplayName: response.DisplayName, Revision: configuration, Enabled: response.Enabled,
		CreatedAt: response.CreatedAt, UpdatedAt: response.UpdatedAt,
	}, nil
}
