package ports

import (
	"context"
	"time"
)

type CatalogResourceKind string

const (
	CatalogProvider               CatalogResourceKind = "provider"
	CatalogModel                  CatalogResourceKind = "model"
	CatalogTemplate               CatalogResourceKind = "template"
	SetCatalogAvailabilityRequest CatalogRequestKind  = "set_catalog_availability"
)

type CatalogAvailabilityChange struct {
	Kind            CatalogResourceKind
	ResourceID      string
	OrganizationID  string
	RequestID       string
	Fingerprint     string
	ExpectedEnabled bool
	Enabled         bool
	Now             time.Time
}

type CatalogAvailability struct {
	ResourceID string    `json:"resource_id"`
	Enabled    bool      `json:"enabled"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type CatalogReference struct {
	Kind        string `json:"kind"`
	ResourceID  string `json:"resource_id"`
	AgentID     string `json:"agent_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`
}

type CatalogReferenceConflict struct {
	References []CatalogReference
	Truncated  bool
}

func (*CatalogReferenceConflict) Error() string { return "catalog resource is in use" }

type CatalogAvailabilityStore interface {
	SetCatalogAvailability(context.Context, CatalogAvailabilityChange) (CatalogAvailability, error)
}
