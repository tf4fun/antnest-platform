package registry

import (
	"bytes"
	"context"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresPublicationSurvivesRestartAndConflictingAppends(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_SKILL_REGISTRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_SKILL_REGISTRY_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	service := NewService(NewPostgresStore(pool))
	firstArchive := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nFirst revision.\n")
	firstInput := PublishInput{RequestID: "registry-postgres-create", OrganizationID: testOrg,
		ActorID: testActor, Artifact: firstArchive}
	first, err := service.Publish(ctx, firstInput)
	if err != nil || first.Version != 1 {
		t.Fatalf("publish first version: %+v, %v", first, err)
	}

	// A new Store instance must replay the committed receipt and artifact bytes.
	restarted := NewService(NewPostgresStore(pool))
	replayed, err := restarted.Publish(ctx, firstInput)
	if err != nil || replayed != first {
		t.Fatalf("replay after restart: %+v, %v; want %+v", replayed, err, first)
	}
	metadata, artifact, err := NewPostgresStore(pool).Artifact(ctx, testOrg, first.SkillID, 1)
	if err != nil || metadata != first || !bytes.Equal(artifact, firstArchive) {
		t.Fatalf("persisted artifact differs: %+v, %v", metadata, err)
	}
	if _, err := restarted.Resolve(ctx, testOther, []Reference{{SkillID: first.SkillID, Version: 1}}); Code(err) != "not_found" {
		t.Fatalf("other organization resolved a Skill: %v", err)
	}

	archives := [][]byte{
		skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nSecond A.\n"),
		skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nSecond B.\n"),
	}
	type result struct {
		value Version
		err   error
	}
	results := make([]result, len(archives))
	var workers sync.WaitGroup
	for i := range archives {
		workers.Add(1)
		go func() {
			defer workers.Done()
			results[i].value, results[i].err = restarted.Publish(ctx, PublishInput{
				RequestID:      "registry-postgres-append-" + string(rune('a'+i)),
				OrganizationID: testOrg, ActorID: testActor, SkillID: first.SkillID,
				ExpectedVersion: 1, Artifact: archives[i],
			})
		}()
	}
	workers.Wait()
	succeeded, conflicted := 0, 0
	for _, outcome := range results {
		switch {
		case outcome.err == nil && outcome.value.Version == 2:
			succeeded++
		case Code(outcome.err) == "revision_conflict":
			conflicted++
		default:
			t.Fatalf("unexpected concurrent append outcome: %+v", outcome)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("concurrent append outcomes: %+v", results)
	}
	page, err := restarted.Versions(ctx, testOrg, first.SkillID, 0, 10)
	if err != nil || len(page.Items) != 2 || page.Items[0].Version != 1 || page.Items[1].Version != 2 {
		t.Fatalf("versions after conflict: %+v, %v", page, err)
	}
	var receiptCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM command_receipts WHERE organization_id=$1`, testOrg).Scan(&receiptCount); err != nil || receiptCount != 2 {
		t.Fatalf("failed append left a receipt: count=%d err=%v", receiptCount, err)
	}
}
