package ports

import (
	"context"
	"encoding/json"
	"strconv"
)

type MCPSecretLocation struct {
	OrganizationID string `json:"organization_id"`
	TemplateID     string `json:"template_id"`
	Revision       int64  `json:"revision"`
	ServerID       string `json:"server_id"`
	Name           string `json:"name"`
}

func (location MCPSecretLocation) CredentialIdentity() CredentialIdentity {
	ref, _ := json.Marshal([]string{"managed-mcp", location.TemplateID, location.ServerID, location.Name})
	return CredentialIdentity{OrganizationID: location.OrganizationID, CredentialRef: string(ref), CredentialVersion: strconv.FormatInt(location.Revision, 10)}
}

type MCPSecretRecord struct {
	Location    MCPSecretLocation
	Fingerprint string
	Sealed      SealedSecret
}

type MCPSecretReader interface {
	GetMCPSecret(context.Context, MCPSecretLocation) (MCPSecretRecord, error)
}

type MCPTemplateSource struct {
	OrganizationID string `json:"organization_id"`
	TemplateID     string `json:"template_id"`
	Revision       int64  `json:"revision"`
}
