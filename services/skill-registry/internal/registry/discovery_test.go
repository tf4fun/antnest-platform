package registry

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
)

const testAgent = "agent_00000000000000000000000000000001"
const testOtherActor = "user_00000000000000000000000000000002"

type memoryProjectionStore struct {
	values map[string]Projection
	formal *memoryStore
}

func projectionKey(org, agent, name string) string { return org + "/" + agent + "/" + name }
func (m *memoryProjectionStore) UpsertProjection(_ context.Context, p Projection) (ProjectionResult, error) {
	if m.values == nil {
		m.values = map[string]Projection{}
	}
	key := projectionKey(p.OrganizationID, p.AgentID, p.Name)
	old, ok := m.values[key]
	if ok && p.Sequence < old.Sequence {
		return ProjectionResult{Outcome: "superseded", Sequence: old.Sequence}, nil
	}
	if ok && p.Sequence == old.Sequence {
		if old != p {
			return ProjectionResult{}, failure("request_conflict", "sequence changed")
		}
		return ProjectionResult{Outcome: "replayed", Sequence: old.Sequence}, nil
	}
	m.values[key] = p
	return ProjectionResult{Outcome: "applied", Sequence: p.Sequence}, nil
}
func (m *memoryProjectionStore) GetProjection(_ context.Context, org, agent, name string) (Projection, error) {
	p, ok := m.values[projectionKey(org, agent, name)]
	if !ok {
		return Projection{}, failure("not_found", "missing")
	}
	return p, nil
}
func (m *memoryProjectionStore) SearchCandidates(ctx context.Context, in SearchInput) ([]DiscoveryItem, error) {
	out := make([]DiscoveryItem, 0)
	for _, p := range m.values {
		if p.OrganizationID == in.OrganizationID && p.OwnerID == in.ActorID && p.Active && p.AgentID != in.RequestingAgentID && matchesQuery(p.Name, p.Description, in.Query) {
			out = append(out, projectionItem(p))
		}
	}
	if m.formal != nil {
		items, _ := m.formal.List(ctx, in.OrganizationID, "", 100)
		for _, s := range items {
			if matchesQuery(s.Name, s.Description, in.Query) {
				out = append(out, DiscoveryItem{SkillRef: SkillRef{Kind: "registry", SkillID: s.SkillID, Version: s.CurrentVersion}, Name: s.Name, Description: s.Description, ContentDigest: s.ContentDigest})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return discoveryOrder(out[i]) < discoveryOrder(out[j]) })
	if len(out) > in.Limit {
		out = out[:in.Limit]
	}
	return out, nil
}

type fakeAgentSource struct {
	current Projection
	archive []byte
	err     error
	calls   int
}

func (f *fakeAgentSource) Inspect(_ context.Context, org, actor string, keys []SourceKey) ([]Projection, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := []Projection{}
	for _, key := range keys {
		if f.current.Active && f.current.OrganizationID == org && f.current.OwnerID == actor && key.AgentID == f.current.AgentID && key.Name == f.current.Name {
			out = append(out, f.current)
		}
	}
	return out, nil
}
func (f *fakeAgentSource) Artifact(_ context.Context, in SourceArtifactInput) ([]byte, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	p := f.current
	if !p.Active || p.OrganizationID != in.OrganizationID || p.OwnerID != in.ActorID || p.AgentID != in.SkillRef.AgentID || p.Name != in.SkillRef.Name {
		return nil, failure("not_found", "not readable")
	}
	if p.Sequence != in.SkillRef.Sequence || p.ContentDigest != in.ExpectedDigest {
		return nil, failure("content_changed", "changed")
	}
	return append([]byte(nil), f.archive...), nil
}
func discoveryFixture(t *testing.T) (*Discovery, *memoryStore, *memoryProjectionStore, *fakeAgentSource, LoadInput) {
	t.Helper()
	archive := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nRead first.\n")
	pkg, err := ValidatePackage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	p := Projection{OrganizationID: testOrg, AgentID: testAgent, OwnerID: testActor, Name: pkg.Name, Description: pkg.Description, Sequence: 1, ContentDigest: pkg.ContentDigest, Active: true}
	store := &memoryStore{}
	index := &memoryProjectionStore{formal: store}
	source := &fakeAgentSource{current: p, archive: archive}
	service := NewDiscovery(NewService(store), index, source)
	if _, err := service.Update(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	input := LoadInput{OrganizationID: testOrg, ActorID: testActor, SkillRef: projectionItem(p).SkillRef, ExpectedDigest: p.ContentDigest}
	return service, store, index, source, input
}
func TestDiscoveryProjectionOrderAndMetadataOnly(t *testing.T) {
	d, store, index, source, _ := discoveryFixture(t)
	p := source.current
	if out, err := d.Update(context.Background(), p); err != nil || out.Outcome != "replayed" {
		t.Fatalf("%+v %v", out, err)
	}
	p.Description = "Changed without sequence"
	if _, err := d.Update(context.Background(), p); Code(err) != "request_conflict" {
		t.Fatalf("same sequence: %v", err)
	}
	removed := source.current
	removed.Sequence = 2
	removed.Active = false
	if _, err := d.Update(context.Background(), removed); err != nil {
		t.Fatal(err)
	}
	if out, err := d.Update(context.Background(), source.current); err != nil || out.Outcome != "superseded" || out.Sequence != 2 {
		t.Fatalf("late replay: %+v %v", out, err)
	}
	if current, _ := index.GetProjection(context.Background(), testOrg, testAgent, p.Name); current.Active {
		t.Fatal("resurrected mapping")
	}
	if len(store.archives) != 0 || len(store.items) != 0 {
		t.Fatal("projection stored package")
	}
	invalid := source.current
	invalid.Sequence = 0
	if _, err := d.Update(context.Background(), invalid); Code(err) != "invalid_request" {
		t.Fatalf("bad sequence: %v", err)
	}
}
func TestDiscoverySearchUsesCurrentPermissionAndMetadata(t *testing.T) {
	d, _, _, source, _ := discoveryFixture(t)
	input := SearchInput{OrganizationID: testOrg, ActorID: testActor, Query: "review"}
	items, err := d.Search(context.Background(), input)
	if err != nil || len(items) != 1 || items[0].SkillRef.Kind != "agent" {
		t.Fatalf("%+v %v", items, err)
	}
	source.current.Sequence = 2
	source.current.Description = "Review the latest code"
	items, err = d.Search(context.Background(), input)
	if err != nil || len(items) != 1 || items[0].SkillRef.Sequence != 2 || items[0].Description != source.current.Description {
		t.Fatalf("stale index: %+v %v", items, err)
	}
	source.current.Active = false
	if items, err = d.Search(context.Background(), input); err != nil || len(items) != 0 {
		t.Fatalf("deleted source: %+v %v", items, err)
	}
	source.current.Active = true
	source.err = failure("source_unavailable", "offline")
	if _, err = d.Search(context.Background(), input); Code(err) != "source_unavailable" {
		t.Fatalf("offline became empty success: %v", err)
	}
	for _, in := range []SearchInput{
		{OrganizationID: testOrg, ActorID: testOtherActor, Query: "review"},
		{OrganizationID: testOther, ActorID: testActor, Query: "review"},
	} {
		if items, err = d.Search(context.Background(), in); err != nil || len(items) != 0 {
			t.Fatalf("scope leak: %+v %v", items, err)
		}
	}
}
func TestDiscoveryTemporaryLoadDoesNotPersistAndRejectsDrift(t *testing.T) {
	d, store, _, source, input := discoveryFixture(t)
	loaded, err := d.Load(context.Background(), input)
	if err != nil || !bytes.Equal(loaded.Package.Artifact, source.archive) || loaded.Package.ContentDigest != input.ExpectedDigest {
		t.Fatalf("%+v %v", loaded, err)
	}
	if len(store.archives) != 0 || len(store.receipts) != 0 {
		t.Fatal("temporary load was published")
	}
	source.current.Sequence++
	if _, err = d.Load(context.Background(), input); Code(err) != "content_changed" {
		t.Fatalf("changed source accepted: %v", err)
	}
	source.current.Sequence--
	source.archive = skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nChanged bytes.\n")
	if _, err = d.Load(context.Background(), input); Code(err) != "content_changed" {
		t.Fatalf("wrong digest accepted: %v", err)
	}
	source.archive = []byte("not a ZIP")
	if _, err = d.Load(context.Background(), input); Code(err) != "source_invalid" {
		t.Fatalf("bad source package: %v", err)
	}
	input.ActorID = testOtherActor
	before := source.calls
	if _, err = d.Load(context.Background(), input); Code(err) != "not_found" || source.calls != before {
		t.Fatalf("other owner fetched source: %v", err)
	}
}
func TestDiscoveryPromotionReplaysWithoutSourceAndSurvivesRemoval(t *testing.T) {
	d, store, index, source, load := discoveryFixture(t)
	in := PromoteInput{RequestID: "promotion-1", OrganizationID: load.OrganizationID, ActorID: load.ActorID, SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest}
	first, err := d.Promote(context.Background(), in)
	if err != nil || first.Version != 1 || source.calls != 1 {
		t.Fatalf("promote: %+v %v", first, err)
	}
	removed := source.current
	removed.Sequence = 2
	removed.Active = false
	_, _ = d.Update(context.Background(), removed)
	source.current = removed
	source.err = errors.New("offline")
	replay, err := d.Promote(context.Background(), in)
	if err != nil || replay != first || source.calls != 1 {
		t.Fatalf("replay consulted source: %+v %v", replay, err)
	}
	formal := LoadInput{OrganizationID: testOrg, ActorID: testActor, SkillRef: SkillRef{Kind: "registry", SkillID: first.SkillID, Version: 1}, ExpectedDigest: first.ContentDigest}
	if loaded, err := d.Load(context.Background(), formal); err != nil || !bytes.Equal(loaded.Package.Artifact, source.archive) {
		t.Fatalf("independent formal load: %v", err)
	}
	if len(store.archives) != 1 || len(index.values) != 1 {
		t.Fatal("wrong ownership storage")
	}
	in.ExpectedDigest = "sha256:" + strings.Repeat("f", 64)
	if _, err = d.Promote(context.Background(), in); Code(err) != "request_conflict" || source.calls != 1 {
		t.Fatalf("changed replay: %v", err)
	}
}
func TestDiscoveryRejectsBadSearchAndMixedReferences(t *testing.T) {
	d, _, _, _, load := discoveryFixture(t)
	for _, in := range []SearchInput{
		{OrganizationID: testOrg, ActorID: testActor, Query: " "},
		{OrganizationID: testOrg, ActorID: testActor, Query: strings.Repeat("界", 100)},
		{OrganizationID: testOrg, ActorID: testActor, Query: "review", Limit: 51},
	} {
		if _, err := d.Search(context.Background(), in); Code(err) != "invalid_request" {
			t.Fatalf("accepted bad search: %v", err)
		}
	}
	load.SkillRef.SkillID = "skill_" + strings.Repeat("a", 32)
	if _, err := d.Load(context.Background(), load); Code(err) != "invalid_request" {
		t.Fatalf("mixed ref: %v", err)
	}
}
