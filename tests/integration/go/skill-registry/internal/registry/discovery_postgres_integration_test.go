package registry

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func discoveryDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	address := os.Getenv("ANTNEST_SKILL_REGISTRY_TEST_DATABASE_URL")
	if address == "" {
		t.Skip("ANTNEST_SKILL_REGISTRY_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, address)
	if err != nil {
		t.Fatal(err)
	}
	schema := "discovery_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(address)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, err := admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
		if err != nil {
			t.Error(err)
		}
	})
	return pool
}
func TestDiscoveryPostgresUpgradesBaseAndPersistsOnlyMappingUntilPromotion(t *testing.T) {
	pool := discoveryDatabase(t)
	ctx := context.Background()
	base, err := migrationFS.ReadFile("migrations/0001_registry.sql")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(base)
	checksum := hex.EncodeToString(sum[:])
	if _, err := pool.Exec(ctx, string(base)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO schema_migrations(name,checksum) VALUES('0001_registry.sql',$1)", checksum); err != nil {
		t.Fatal(err)
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var recorded string
	if err := pool.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE name='0001_registry.sql'").Scan(&recorded); err != nil || recorded != checksum {
		t.Fatalf("base rewritten: %v", err)
	}
	_, _, _, source, load := discoveryFixture(t)
	store := NewPostgresStore(pool)
	d := NewDiscovery(NewService(store), store, source)
	if _, err := d.Update(ctx, source.current); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Load(ctx, load); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM skill_versions").Scan(&count); err != nil || count != 0 {
		t.Fatalf("projected/loaded bytes persisted: %d %v", count, err)
	}
	var columns int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='skill_projections' AND column_name IN ('artifact','instructions','skill_text','file_manifest')").Scan(&columns); err != nil || columns != 0 {
		t.Fatalf("projection stores content: %d %v", columns, err)
	}
	in := PromoteInput{RequestID: "pg-promote", OrganizationID: testOrg, ActorID: testActor, SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest}
	first, err := d.Promote(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	var provenance []byte
	if err := pool.QueryRow(ctx, "SELECT provenance FROM skill_version_sources WHERE skill_id=$1 AND version=1", first.SkillID).Scan(&provenance); err != nil {
		t.Fatal(err)
	}
	var origin SourceProvenance
	if err := json.Unmarshal(provenance, &origin); err != nil || origin.SkillRef != load.SkillRef || origin.ContentDigest != load.ExpectedDigest {
		t.Fatalf("missing provenance: %+v %v", origin, err)
	}
	removed := source.current
	removed.Sequence = 2
	removed.Active = false
	if _, err := d.Update(ctx, removed); err != nil {
		t.Fatal(err)
	}
	source.err = failure("source_unavailable", "offline")
	restarted := NewDiscovery(NewService(NewPostgresStore(pool)), NewPostgresStore(pool), source)
	if replay, err := restarted.Promote(ctx, in); err != nil || replay != first {
		t.Fatalf("restart replay: %+v %v", replay, err)
	}
	formal := LoadInput{OrganizationID: testOrg, ActorID: testActor, SkillRef: SkillRef{Kind: "registry", SkillID: first.SkillID, Version: 1}, ExpectedDigest: first.ContentDigest}
	if got, err := restarted.Load(ctx, formal); err != nil || !bytes.Equal(got.Package.Artifact, source.archive) {
		t.Fatalf("formal depends on source: %v", err)
	}
	if out, err := restarted.Update(ctx, source.current); err != nil || out.Outcome != "superseded" {
		t.Fatalf("revived removed source: %+v %v", out, err)
	}
	if values, err := restarted.Search(ctx, SearchInput{OrganizationID: testOther, ActorID: testActor, Query: "review"}); err != nil || len(values) != 0 {
		t.Fatalf("org leak: %+v %v", values, err)
	}
}

func TestDiscoveryPostgresExcludesRequestingAgentBeforeLimitWithoutChangingScope(t *testing.T) {
	pool := discoveryDatabase(t)
	ctx := context.Background()
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	_, _, _, source, _ := discoveryFixture(t)
	caller := source.current
	other := caller
	other.AgentID = "agent_00000000000000000000000000000002"
	source.current = other
	store := NewPostgresStore(pool)
	d := NewDiscovery(NewService(store), store, source)
	for _, p := range []Projection{caller, other} {
		if _, err := d.Update(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	var input SearchInput
	if err := json.Unmarshal(mustJSON(t, map[string]any{
		"organization_id": testOrg, "actor_id": testActor, "query": "review",
		"requesting_agent_id": caller.AgentID, "limit": 1,
	}), &input); err != nil {
		t.Fatal(err)
	}
	items, err := d.Search(ctx, input)
	if err != nil || len(items) != 1 || items[0].SkillRef.AgentID != other.AgentID {
		t.Fatalf("caller consumed the sole candidate slot: %+v %v", items, err)
	}
	for _, in := range []SearchInput{
		{OrganizationID: testOther, ActorID: testActor, Query: "review", Limit: 1},
		{OrganizationID: testOrg, ActorID: testOtherActor, Query: "review", Limit: 1},
	} {
		if items, err := d.Search(ctx, in); err != nil || len(items) != 0 {
			t.Fatalf("caller filtering changed read scope: %+v %v", items, err)
		}
	}
}
func TestDiscoveryPostgresConcurrentOrderAndPromotionCASRollback(t *testing.T) {
	pool := discoveryDatabase(t)
	ctx := context.Background()
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	_, _, _, source, load := discoveryFixture(t)
	store := NewPostgresStore(pool)
	d := NewDiscovery(NewService(store), store, source)
	var group sync.WaitGroup
	errors := make(chan error, 8)
	for i := range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			p := source.current
			p.Sequence = int64(i + 1)
			_, err := d.Update(ctx, p)
			if err != nil {
				errors <- err
			}
		}()
	}
	group.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	latest, err := store.GetProjection(ctx, testOrg, testAgent, source.current.Name)
	if err != nil || latest.Sequence != 8 {
		t.Fatalf("out of order head: %+v %v", latest, err)
	}
	source.current.Sequence = 8
	load.SkillRef.Sequence = 8
	first, err := d.Promote(ctx, PromoteInput{RequestID: "pg-create", OrganizationID: testOrg, ActorID: testActor, SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest})
	if err != nil {
		t.Fatal(err)
	}
	archive := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nUpdated source.\n")
	pkg, err := ValidatePackage(ctx, archive)
	if err != nil {
		t.Fatal(err)
	}
	source.current.Sequence = 9
	source.current.ContentDigest = pkg.ContentDigest
	source.archive = archive
	if _, err := d.Update(ctx, source.current); err != nil {
		t.Fatal(err)
	}
	inputs := []PromoteInput{
		{RequestID: "pg-append-a", OrganizationID: testOrg, ActorID: testActor, SkillRef: projectionItem(source.current).SkillRef, ExpectedDigest: pkg.ContentDigest, SkillID: first.SkillID, ExpectedVersion: 1},
		{RequestID: "pg-append-b", OrganizationID: testOrg, ActorID: testActor, SkillRef: projectionItem(source.current).SkillRef, ExpectedDigest: pkg.ContentDigest, SkillID: first.SkillID, ExpectedVersion: 1},
	}
	outcomes := make([]error, 2)
	for i, in := range inputs {
		group.Add(1)
		go func() {
			defer group.Done()
			local := *source
			worker := NewDiscovery(NewService(store), store, &local)
			_, outcomes[i] = worker.Promote(ctx, in)
		}()
	}
	group.Wait()
	succeeded, conflicted := 0, 0
	for _, err := range outcomes {
		if err == nil {
			succeeded++
		} else if Code(err) == "revision_conflict" {
			conflicted++
		} else {
			t.Fatal(err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("CAS outcomes %+v", outcomes)
	}
	for _, table := range []string{"skill_versions", "command_receipts", "skill_version_sources"} {
		var count int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 2 {
			t.Fatalf("loser persisted in %s: %d %v", table, count, err)
		}
	}
}
