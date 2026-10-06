package application

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (service *CatalogService) mcpFingerprint(ctx context.Context, record ports.MCPSecretRecord, value string) (string, error) {
	authenticator, ok := service.sealer.(ports.CredentialAuthenticator)
	if !ok {
		return "", errors.New("managed MCP secret authentication unavailable")
	}
	mac, err := authenticator.Authenticate(ctx, record.Location.CredentialIdentity(), record.Sealed, "managed-mcp-public-fingerprint-v1", []byte(value))
	if err != nil || len(mac) != 32 {
		return "", errors.New("managed MCP secret authentication failed")
	}
	return "hmac-sha256:" + hex.EncodeToString(mac[:16]), nil
}

// Receipts containing plaintext writes use an envelope-bound MAC, never a
// publicly guessable hash. The original revision supplies the key on replay.
func (service *CatalogService) templateRequestFingerprint(ctx context.Context, input any, records []ports.MCPSecretRecord) (string, error) {
	if len(records) == 0 {
		return requestFingerprint(input)
	}
	records = slices.Clone(records)
	slices.SortFunc(records, func(a, b ports.MCPSecretRecord) int {
		if compare := strings.Compare(a.Location.ServerID, b.Location.ServerID); compare != 0 {
			return compare
		}
		return strings.Compare(a.Location.Name, b.Location.Name)
	})
	authenticator, ok := service.sealer.(ports.CredentialAuthenticator)
	if !ok {
		return "", errors.New("managed MCP request authentication unavailable")
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	defer clear(payload)
	record := records[0]
	mac, err := authenticator.Authenticate(ctx, record.Location.CredentialIdentity(), record.Sealed, "managed-mcp-request-fingerprint-v1", payload)
	if err != nil || len(mac) != 32 {
		return "", errors.New("managed MCP request authentication failed")
	}
	return "hmac-sha256:" + hex.EncodeToString(mac), nil
}

func (service *CatalogService) replayTemplateInput(ctx context.Context, kind ports.CatalogRequestKind, requestID, organizationID string, input any) (ports.TemplateRecord, bool, error) {
	receipt, found, err := service.store.LookupTemplateRequest(ctx, kind, requestID)
	if err != nil || !found {
		return receipt, found, err
	}
	if receipt.OrganizationID != organizationID {
		return ports.TemplateRecord{}, false, ports.ErrRequestConflict
	}
	var records []ports.MCPSecretRecord
	if strings.HasPrefix(receipt.RequestFingerprint, "hmac-sha256:") {
		reader, ok := service.store.(ports.MCPSecretReader)
		if !ok {
			return ports.TemplateRecord{}, false, errors.New("managed MCP receipt verification unavailable")
		}
		// Only identities from the frozen receipt may select its MAC key.
		for _, server := range receipt.Revision.Snapshot().Runtime.MCPServers {
			for name := range server.SecretEnv {
				location := ports.MCPSecretLocation{OrganizationID: receipt.OrganizationID, TemplateID: receipt.TemplateID, Revision: receipt.Revision.Revision(), ServerID: server.ID, Name: name}
				record, err := reader.GetMCPSecret(ctx, location)
				if err != nil {
					return ports.TemplateRecord{}, false, errors.New("managed MCP receipt secret unavailable")
				}
				records = append(records, record)
			}
		}
		if len(records) == 0 {
			return ports.TemplateRecord{}, false, errors.New("managed MCP receipt identity unavailable")
		}
	}
	fingerprint, err := service.templateRequestFingerprint(ctx, input, records)
	if err != nil {
		return ports.TemplateRecord{}, false, err
	}
	return service.store.ReplayTemplateRequest(ctx, kind, requestID, fingerprint)
}

func containsMCPValueWrite(servers []domain.MCPServer) bool {
	for _, server := range servers {
		for _, secret := range server.SecretEnv {
			if secret.Value != nil {
				return true
			}
		}
	}
	return false
}

func (service *CatalogService) sealMCPSecrets(ctx context.Context, source ports.MCPTemplateSource, servers []domain.MCPServer) ([]domain.MCPServer, []ports.MCPSecretRecord, error) {
	result := domain.CloneMCPServers(servers)
	resolved := domain.CloneMCPServers(servers)
	var records []ports.MCPSecretRecord
	for index, server := range result {
		resolved[index].SecretEnv = nil
		for name, secret := range server.SecretEnv {
			if secret.Set || secret.Fingerprint != "" || (secret.Value == nil) == !secret.Keep {
				return nil, nil, fmt.Errorf("%w: secret requires exactly value or keep=true", ErrInvalidInput)
			}
			if _, duplicate := server.Env[name]; duplicate {
				return nil, nil, fmt.Errorf("%w: overlapping MCP environment names", ErrInvalidInput)
			}
			location := ports.MCPSecretLocation{OrganizationID: source.OrganizationID, TemplateID: source.TemplateID, Revision: source.Revision, ServerID: server.ID, Name: name}
			value := ""
			if secret.Keep {
				reader, ok := service.store.(ports.MCPSecretReader)
				if source.Revision < 2 || !ok || service.opener == nil {
					return nil, nil, fmt.Errorf("%w: keep requires an existing secret at the same server and name", ErrInvalidInput)
				}
				previous := location
				previous.Revision--
				record, err := reader.GetMCPSecret(ctx, previous)
				if errors.Is(err, ports.ErrNotFound) {
					return nil, nil, fmt.Errorf("%w: kept secret does not exist", ErrInvalidInput)
				}
				if err != nil {
					return nil, nil, errors.New("read kept managed MCP secret failed")
				}
				value, err = service.opener.Open(ctx, previous.CredentialIdentity(), record.Sealed)
				if err != nil {
					return nil, nil, errors.New("open kept managed MCP secret failed")
				}
			} else {
				value = *secret.Value
			}
			resolved[index].Env[name] = value
			if service.sealer == nil {
				return nil, nil, errors.New("managed MCP secret sealing unavailable")
			}
			sealed, err := service.sealer.Seal(ctx, location.CredentialIdentity(), value)
			if err != nil {
				return nil, nil, errors.New("seal managed MCP secret failed")
			}
			record := ports.MCPSecretRecord{Location: location, Sealed: sealed}
			fingerprint, err := service.mcpFingerprint(ctx, record, value)
			if err != nil {
				return nil, nil, err
			}
			record.Fingerprint = fingerprint
			records = append(records, record)
			result[index].SecretEnv[name] = domain.MCPSecret{Set: true, Fingerprint: fingerprint}
		}
	}
	if err := domain.ValidateMCPServers(resolved); err != nil {
		return nil, nil, fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	if err := domain.ValidateMCPServers(result); err != nil {
		return nil, nil, fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	return result, records, nil
}

// ResolveMCPSecrets is a workload-only bootstrap operation, never a catalog read.
func (service *CatalogService) ResolveMCPSecrets(ctx context.Context, source ports.MCPTemplateSource) (map[string]map[string]string, error) {
	if !validIdentifier(source.OrganizationID) || !validIdentifier(source.TemplateID) || source.Revision < 1 {
		return nil, ErrInvalidInput
	}
	revision, err := service.store.GetTemplateRevision(ctx, source.TemplateID, source.Revision)
	if err != nil {
		return nil, err
	}
	if revision.Snapshot().OrganizationID != source.OrganizationID {
		return nil, ports.ErrNotFound
	}
	reader, ok := service.store.(ports.MCPSecretReader)
	if !ok || service.opener == nil {
		return nil, errors.New("managed MCP secret resolver unavailable")
	}
	result := make(map[string]map[string]string)
	for _, server := range revision.Snapshot().Runtime.MCPServers {
		if len(server.SecretEnv) == 0 {
			continue
		}
		values := make(map[string]string)
		for name, descriptor := range server.SecretEnv {
			location := ports.MCPSecretLocation{OrganizationID: source.OrganizationID, TemplateID: source.TemplateID, Revision: source.Revision, ServerID: server.ID, Name: name}
			record, err := reader.GetMCPSecret(ctx, location)
			if err != nil {
				return nil, errors.New("managed MCP bootstrap secret unavailable")
			}
			value, err := service.opener.Open(ctx, location.CredentialIdentity(), record.Sealed)
			if err != nil {
				return nil, errors.New("managed MCP bootstrap secret verification failed")
			}
			fingerprint, err := service.mcpFingerprint(ctx, record, value)
			if err != nil || fingerprint != descriptor.Fingerprint || record.Fingerprint != descriptor.Fingerprint {
				return nil, errors.New("managed MCP bootstrap secret verification failed")
			}
			values[name] = value
		}
		result[server.ID] = values
	}
	return result, nil
}

func publicMCPRuntime(input domain.RuntimeSpecInput) domain.RuntimeSpecInput {
	input.MCPServers = domain.CloneMCPServers(input.MCPServers)
	for index, server := range input.MCPServers {
		for name, secret := range server.SecretEnv {
			input.MCPServers[index].SecretEnv[name] = domain.MCPSecret{Set: secret.Set, Fingerprint: secret.Fingerprint}
		}
	}
	return input
}

func mcpTemplateSource(organizationID string, snapshot domain.AgentSpecSnapshot) *ports.MCPTemplateSource {
	for _, server := range snapshot.Runtime.MCPServers {
		if len(server.SecretEnv) > 0 {
			return &ports.MCPTemplateSource{OrganizationID: organizationID, TemplateID: snapshot.TemplateID, Revision: snapshot.TemplateRevision}
		}
	}
	return nil
}
