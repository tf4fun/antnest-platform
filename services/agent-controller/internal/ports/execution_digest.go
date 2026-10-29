package ports

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"slices"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

const ExecutionSchemaVersion2 = 2

var executionDigestHex = regexp.MustCompile(`^[0-9a-f]{64}$`)

type ExecutionDigestEntry struct {
	ID     string `json:"id"`
	Digest string `json:"digest"`
}

type ExecutionDigest struct {
	OrganizationID           string                 `json:"organization_id"`
	SchemaVersion            int                    `json:"schema_version"`
	Revision                 int64                  `json:"revision"`
	Digest                   *string                `json:"digest"`
	Providers                []ExecutionDigestEntry `json:"providers"`
	Models                   []ExecutionDigestEntry `json:"models"`
	Agents                   []ExecutionDigestEntry `json:"agents"`
	OrganizationBudgetDigest *string                `json:"organization_budget_digest"`
}

type ExecutionCollectionDelta[T any] struct {
	Upserts []T      `json:"upserts"`
	Deletes []string `json:"deletes"`
}

type ExecutionDelta struct {
	SchemaVersion      int                                         `json:"schema_version"`
	OrganizationID     string                                      `json:"organization_id"`
	BaseRevision       int64                                       `json:"base_revision"`
	Revision           int64                                       `json:"revision"`
	Providers          ExecutionCollectionDelta[ExecutionProvider] `json:"providers"`
	Models             ExecutionCollectionDelta[ExecutionModel]    `json:"models"`
	Agents             ExecutionCollectionDelta[ExecutionAgent]    `json:"agents"`
	OrganizationBudget *domain.OrganizationBudget                  `json:"organization_budget"`
}

type ExecutionCredentialRequest struct {
	OrganizationID    string `json:"organization_id"`
	ConnectionID      string `json:"connection_id"`
	CredentialVersion string `json:"credential_version"`
}

type ResolvedExecutionCredential struct {
	OrganizationID    string `json:"organization_id"`
	ConnectionID      string `json:"connection_id"`
	CredentialVersion string `json:"credential_version"`
	Method            string `json:"method"`
	Secret            string `json:"secret"`
}

func (digest ExecutionDigest) Validate() error {
	if !executionIdentifier.MatchString(digest.OrganizationID) || digest.SchemaVersion < 0 || digest.SchemaVersion > 2 ||
		digest.Revision < 0 || digest.Revision > MaximumExecutionRevision ||
		digest.Providers == nil || digest.Models == nil || digest.Agents == nil {
		return ErrInvalidExecutionConfiguration
	}
	for _, entries := range [][]ExecutionDigestEntry{digest.Providers, digest.Models, digest.Agents} {
		seen := make(map[string]bool, len(entries))
		for _, entry := range entries {
			if !executionIdentifier.MatchString(entry.ID) || !executionDigestHex.MatchString(entry.Digest) || seen[entry.ID] {
				return ErrInvalidExecutionConfiguration
			}
			seen[entry.ID] = true
		}
	}
	if digest.OrganizationBudgetDigest != nil && !executionDigestHex.MatchString(*digest.OrganizationBudgetDigest) {
		return ErrInvalidExecutionConfiguration
	}
	if digest.SchemaVersion == 0 {
		if digest.Revision != 0 || digest.Digest != nil || len(digest.Providers) != 0 || len(digest.Models) != 0 ||
			len(digest.Agents) != 0 || digest.OrganizationBudgetDigest != nil {
			return ErrInvalidExecutionConfiguration
		}
		return nil
	}
	if digest.Revision < 1 || digest.Digest == nil || !executionDigestHex.MatchString(*digest.Digest) {
		return ErrInvalidExecutionConfiguration
	}
	return nil
}

func (delta ExecutionDelta) Validate() error {
	if delta.SchemaVersion != ExecutionSchemaVersion2 || !executionIdentifier.MatchString(delta.OrganizationID) ||
		delta.BaseRevision < 1 || delta.Revision <= delta.BaseRevision || delta.Revision > MaximumExecutionRevision ||
		delta.Providers.Upserts == nil || delta.Providers.Deletes == nil ||
		delta.Models.Upserts == nil || delta.Models.Deletes == nil ||
		delta.Agents.Upserts == nil || delta.Agents.Deletes == nil {
		return ErrInvalidExecutionConfiguration
	}
	if delta.OrganizationBudget != nil && delta.OrganizationBudget.Validate() != nil {
		return ErrInvalidExecutionConfiguration
	}
	collections := []struct {
		upserts []string
		deletes []string
	}{
		{providerUpsertIDs(delta.Providers.Upserts), delta.Providers.Deletes},
		{modelUpsertIDs(delta.Models.Upserts), delta.Models.Deletes},
		{agentUpsertIDs(delta.Agents.Upserts), delta.Agents.Deletes},
	}
	for _, provider := range delta.Providers.Upserts {
		if !provider.valid(ExecutionSchemaVersion2) {
			return ErrInvalidExecutionConfiguration
		}
	}
	for _, collection := range collections {
		seen := make(map[string]bool, len(collection.upserts)+len(collection.deletes))
		for _, id := range collection.upserts {
			if !executionIdentifier.MatchString(id) || seen[id] {
				return ErrInvalidExecutionConfiguration
			}
			seen[id] = true
		}
		for _, id := range collection.deletes {
			if !executionIdentifier.MatchString(id) || seen[id] {
				return ErrInvalidExecutionConfiguration
			}
			seen[id] = true
		}
	}
	return nil
}

func providerUpsertIDs(upserts []ExecutionProvider) []string {
	ids := make([]string, 0, len(upserts))
	for _, provider := range upserts {
		ids = append(ids, provider.ConnectionID)
	}
	return ids
}

func modelUpsertIDs(upserts []ExecutionModel) []string {
	ids := make([]string, 0, len(upserts))
	for _, model := range upserts {
		ids = append(ids, model.ModelProfileID)
	}
	return ids
}

func agentUpsertIDs(upserts []ExecutionAgent) []string {
	ids := make([]string, 0, len(upserts))
	for _, agent := range upserts {
		ids = append(ids, agent.AgentID)
	}
	return ids
}

type ExecutionDocumentDigests struct {
	Providers          map[string]string
	Models             map[string]string
	Agents             map[string]string
	OrganizationBudget *string
}

func ExecutionCanonicalJSON(document any) ([]byte, error) {
	raw, err := json.Marshal(document)
	if err != nil {
		return nil, ErrInvalidExecutionConfiguration
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, ErrInvalidExecutionConfiguration
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, ErrInvalidExecutionConfiguration
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func publicDocumentDigest(document any, transform func(map[string]any) error) (string, error) {
	raw, err := json.Marshal(document)
	if err != nil {
		return "", ErrInvalidExecutionConfiguration
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", ErrInvalidExecutionConfiguration
	}
	object, ok := value.(map[string]any)
	if !ok {
		return "", ErrInvalidExecutionConfiguration
	}
	if transform != nil {
		if err := transform(object); err != nil {
			return "", err
		}
	}
	canonical, err := ExecutionCanonicalJSON(object)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func publicAgentObject(object map[string]any) error {
	if runtime, ok := object["runtime"].(map[string]any); ok {
		delete(runtime, "credential")
	}
	if raw, present := object["principal_ids"]; present {
		ids, ok := raw.([]any)
		if !ok {
			return ErrInvalidExecutionConfiguration
		}
		sorted := make([]string, 0, len(ids))
		for _, value := range ids {
			id, ok := value.(string)
			if !ok {
				return ErrInvalidExecutionConfiguration
			}
			sorted = append(sorted, id)
		}
		slices.Sort(sorted)
		object["principal_ids"] = sorted
	}
	return nil
}

func PublicExecutionDigests(snapshot ExecutionSnapshot) (ExecutionDocumentDigests, error) {
	result := ExecutionDocumentDigests{
		Providers: make(map[string]string, len(snapshot.Providers)),
		Models:    make(map[string]string, len(snapshot.Models)),
		Agents:    make(map[string]string, len(snapshot.Agents)),
	}
	if snapshot.OrganizationBudget != nil {
		digest, err := publicDocumentDigest(snapshot.OrganizationBudget, nil)
		if err != nil {
			return ExecutionDocumentDigests{}, err
		}
		result.OrganizationBudget = &digest
	}
	for _, provider := range snapshot.Providers {
		digest, err := publicDocumentDigest(provider, func(object map[string]any) error {
			delete(object, "credential")
			return nil
		})
		if err != nil {
			return ExecutionDocumentDigests{}, err
		}
		result.Providers[provider.ConnectionID] = digest
	}
	for _, model := range snapshot.Models {
		digest, err := publicDocumentDigest(model, nil)
		if err != nil {
			return ExecutionDocumentDigests{}, err
		}
		result.Models[model.ModelProfileID] = digest
	}
	for _, agent := range snapshot.Agents {
		digest, err := publicDocumentDigest(agent, publicAgentObject)
		if err != nil {
			return ExecutionDocumentDigests{}, err
		}
		result.Agents[agent.AgentID] = digest
	}
	return result, nil
}

func BuildExecutionDelta(snapshot ExecutionSnapshot, remote ExecutionDigest) (ExecutionDelta, error) {
	if snapshot.SchemaVersion != ExecutionSchemaVersion2 || snapshot.Validate() != nil || remote.Validate() != nil ||
		remote.OrganizationID != snapshot.OrganizationID || remote.SchemaVersion != ExecutionSchemaVersion2 ||
		remote.Revision < 1 || remote.Revision >= snapshot.Revision {
		return ExecutionDelta{}, ErrInvalidExecutionConfiguration
	}
	local, err := PublicExecutionDigests(snapshot)
	if err != nil {
		return ExecutionDelta{}, err
	}
	delta := ExecutionDelta{SchemaVersion: ExecutionSchemaVersion2, OrganizationID: snapshot.OrganizationID,
		BaseRevision: remote.Revision, Revision: snapshot.Revision, OrganizationBudget: snapshot.OrganizationBudget,
		Providers: ExecutionCollectionDelta[ExecutionProvider]{Upserts: []ExecutionProvider{}, Deletes: []string{}},
		Models:    ExecutionCollectionDelta[ExecutionModel]{Upserts: []ExecutionModel{}, Deletes: []string{}},
		Agents:    ExecutionCollectionDelta[ExecutionAgent]{Upserts: []ExecutionAgent{}, Deletes: []string{}}}
	remoteProviders, remoteModels, remoteAgents := digestEntryMap(remote.Providers), digestEntryMap(remote.Models), digestEntryMap(remote.Agents)
	for _, provider := range snapshot.Providers {
		if known, found := remoteProviders[provider.ConnectionID]; !found || known != local.Providers[provider.ConnectionID] {
			delta.Providers.Upserts = append(delta.Providers.Upserts, provider)
		}
	}
	for id := range remoteProviders {
		if _, retained := local.Providers[id]; !retained {
			delta.Providers.Deletes = append(delta.Providers.Deletes, id)
		}
	}
	for _, model := range snapshot.Models {
		if known, found := remoteModels[model.ModelProfileID]; !found || known != local.Models[model.ModelProfileID] {
			delta.Models.Upserts = append(delta.Models.Upserts, model)
		}
	}
	for id := range remoteModels {
		if _, retained := local.Models[id]; !retained {
			delta.Models.Deletes = append(delta.Models.Deletes, id)
		}
	}
	for _, agent := range snapshot.Agents {
		if known, found := remoteAgents[agent.AgentID]; !found || known != local.Agents[agent.AgentID] {
			delta.Agents.Upserts = append(delta.Agents.Upserts, agent)
		}
	}
	for id := range remoteAgents {
		if _, retained := local.Agents[id]; !retained {
			delta.Agents.Deletes = append(delta.Agents.Deletes, id)
		}
	}
	slices.Sort(delta.Providers.Deletes)
	slices.Sort(delta.Models.Deletes)
	slices.Sort(delta.Agents.Deletes)
	if err := delta.Validate(); err != nil {
		return ExecutionDelta{}, err
	}
	return delta, nil
}

func digestEntryMap(entries []ExecutionDigestEntry) map[string]string {
	result := make(map[string]string, len(entries))
	for _, entry := range entries {
		result[entry.ID] = entry.Digest
	}
	return result
}
