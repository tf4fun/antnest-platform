package registry

import (
	"context"
	"sort"
	"strconv"
	"testing"
)

const (
	testOrg   = "org_00000000000000000000000000000001"
	testOther = "org_00000000000000000000000000000002"
	testActor = "user_00000000000000000000000000000001"
)

type memoryStore struct {
	items    map[string][]Version
	receipts map[string]memoryReceipt
	archives map[string][]byte
}

type memoryReceipt struct {
	fingerprint string
	version     Version
}

func (m *memoryStore) Receipt(_ context.Context, org, requestID string) (string, Version, bool, error) {
	value, exists := m.receipts[org+"/"+requestID]
	return value.fingerprint, value.version, exists, nil
}

func (m *memoryStore) Publish(_ context.Context, input PublishRecord) (Version, error) {
	if m.items == nil {
		m.items = map[string][]Version{}
	}
	if m.receipts == nil {
		m.receipts = map[string]memoryReceipt{}
	}
	if m.archives == nil {
		m.archives = map[string][]byte{}
	}
	if previous, exists := m.receipts[input.OrganizationID+"/"+input.RequestID]; exists {
		if previous.fingerprint != input.Fingerprint {
			return Version{}, failure("request_conflict", "request ID changed")
		}
		return previous.version, nil
	}
	key := input.OrganizationID + "/" + input.SkillID
	versions := m.items[key]
	if input.SkillID == "" {
		key = input.OrganizationID + "/" + input.NewSkillID
	}
	if input.SkillID != "" && int64(len(versions)) != input.ExpectedVersion {
		return Version{}, failure("revision_conflict", "head changed")
	}
	value := Version{SkillID: input.NewSkillID, Version: int64(len(versions)) + 1,
		Name: input.Package.Name, Description: input.Package.Description,
		ArtifactDigest: input.Package.ArtifactDigest, ContentDigest: input.Package.ContentDigest,
		ArtifactSize: len(input.Package.Artifact), UnpackedSize: input.Package.UnpackedSize,
		PackageRulesVersion: PackageRulesVersion}
	if input.SkillID != "" {
		value.SkillID = input.SkillID
	}
	m.items[key] = append(versions, value)
	m.receipts[input.OrganizationID+"/"+input.RequestID] = memoryReceipt{input.Fingerprint, value}
	m.archives[key+"/"+strconv.FormatInt(value.Version, 10)] = append([]byte(nil), input.Package.Artifact...)
	return value, nil
}

func (m *memoryStore) GetVersion(_ context.Context, org, skill string, version int64) (Version, error) {
	items := m.items[org+"/"+skill]
	if version < 1 || int(version) > len(items) {
		return Version{}, failure("not_found", "not found")
	}
	return items[version-1], nil
}

func (m *memoryStore) List(_ context.Context, org, after string, limit int) ([]Skill, error) {
	var items []Skill
	for key, versions := range m.items {
		if len(versions) == 0 || len(key) < len(org)+1 || key[:len(org)+1] != org+"/" {
			continue
		}
		latest := versions[len(versions)-1]
		if latest.SkillID <= after {
			continue
		}
		items = append(items, Skill{SkillID: latest.SkillID, Name: latest.Name, CurrentVersion: latest.Version,
			Description: latest.Description, ArtifactDigest: latest.ArtifactDigest, ContentDigest: latest.ContentDigest,
			ArtifactSize: latest.ArtifactSize, UnpackedSize: latest.UnpackedSize, PackageRulesVersion: latest.PackageRulesVersion})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].SkillID < items[j].SkillID })
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (m *memoryStore) Versions(_ context.Context, org, skill string, after int64, limit int) ([]Version, error) {
	versions, ok := m.items[org+"/"+skill]
	if !ok {
		return nil, failure("not_found", "Skill not found")
	}
	var items []Version
	for _, value := range versions {
		if value.Version > after {
			items = append(items, value)
		}
	}
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (m *memoryStore) Artifact(_ context.Context, org, skill string, version int64) (Version, []byte, error) {
	item, err := m.GetVersion(context.Background(), org, skill, version)
	if err != nil {
		return Version{}, nil, err
	}
	return item, append([]byte(nil), m.archives[org+"/"+skill+"/"+strconv.FormatInt(version, 10)]...), nil
}

func TestServicePublishAndResolveFixedVersion(t *testing.T) {
	store := &memoryStore{}
	service := NewService(store)
	artifact := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nRead before editing.\n")
	first, err := service.Publish(context.Background(), PublishInput{RequestID: "request-1", OrganizationID: testOrg, ActorID: testActor, Artifact: artifact})
	if err != nil {
		t.Fatal(err)
	}
	if first.Version != 1 || first.SkillID == "" || first.PackageRulesVersion != 1 {
		t.Fatalf("bad first version: %#v", first)
	}
	second, err := service.Publish(context.Background(), PublishInput{RequestID: "request-2", OrganizationID: testOrg, ActorID: testActor,
		SkillID: first.SkillID, ExpectedVersion: 1, Artifact: artifact})
	if err != nil || second.Version != 2 || second.SkillID != first.SkillID {
		t.Fatalf("bad second version: %#v, %v", second, err)
	}
	items, err := service.Resolve(context.Background(), testOrg, []Reference{{SkillID: first.SkillID, Version: 1}})
	if err != nil || len(items) != 1 || items[0].Version != 1 || items[0].ContentDigest != first.ContentDigest {
		t.Fatalf("fixed resolution changed: %#v, %v", items, err)
	}
	if _, err := service.Resolve(context.Background(), testOther, []Reference{{SkillID: first.SkillID, Version: 1}}); Code(err) != "not_found" {
		t.Fatalf("cross-org resolve: %v", err)
	}
	if _, err := service.Resolve(context.Background(), testOrg, []Reference{{SkillID: first.SkillID, Version: 1}, {SkillID: first.SkillID, Version: 2}}); Code(err) != "invalid_request" {
		t.Fatalf("duplicate skill accepted: %v", err)
	}
	if _, err := service.Publish(context.Background(), PublishInput{RequestID: "request-3", OrganizationID: testOrg, ActorID: testActor,
		SkillID: first.SkillID, ExpectedVersion: 1, Artifact: artifact}); Code(err) != "revision_conflict" {
		t.Fatalf("stale version accepted: %v", err)
	}
	page, err := service.List(context.Background(), testOrg, "", 50)
	if err != nil || len(page.Items) != 1 || page.Items[0].CurrentVersion != 2 || page.Items[0].ContentDigest != second.ContentDigest {
		t.Fatalf("list omitted current metadata: %#v, %v", page, err)
	}
}

func TestServiceRejectsBadIdentityBeforePersistence(t *testing.T) {
	service := NewService(&memoryStore{})
	_, err := service.Publish(context.Background(), PublishInput{RequestID: "r1", OrganizationID: testOrg, ActorID: "a",
		Artifact: skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\n")})
	if Code(err) != "invalid_request" {
		t.Fatalf("accepted bad actor: %v", err)
	}
}

func TestServiceReplaysBeforeNewPackageValidation(t *testing.T) {
	store := &memoryStore{}
	service := NewService(store)
	archive := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\n")
	input := PublishInput{RequestID: "request-replay", OrganizationID: testOrg, ActorID: testActor, Artifact: archive}
	first, err := service.Publish(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Publish(context.Background(), input)
	if err != nil || second != first || len(store.items[testOrg+"/"+first.SkillID]) != 1 {
		t.Fatalf("replay changed publication: %#v %v", second, err)
	}
	input.Artifact = skillZIP(t, "---\nname: different\ndescription: Review code\n---\n")
	if _, err := service.Publish(context.Background(), input); Code(err) != "request_conflict" {
		t.Fatalf("reused request ID accepted: %v", err)
	}
	// A stored v1 receipt must remain replayable if later package rules become stricter.
	// The byte sequence stands in for an artifact accepted by an earlier rules version.
	old := PublishInput{RequestID: "old-request", OrganizationID: testOrg, ActorID: testActor, Artifact: []byte("old-policy-package")}
	store.receipts[testOrg+"/"+old.RequestID] = memoryReceipt{
		fingerprint(old, digest(old.Artifact)), first,
	}
	replayed, err := service.Publish(context.Background(), old)
	if err != nil || replayed != first {
		t.Fatalf("old receipt was revalidated: %#v, %v", replayed, err)
	}
}
