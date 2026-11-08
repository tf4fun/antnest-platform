package postgres

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestResourceIDSkillPreparationPersistsOpaqueOrganization(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	data, err := os.ReadFile("../../../../../contracts/common/id-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors map[string]struct {
		Accept []string `json:"accept"`
		Reject []string `json:"reject"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for index, organization := range vectors["organizationId"].Accept {
		digest, err := skillset.Digest(organization, 1, nil)
		if err != nil {
			t.Fatalf("digest %q: %v", organization, err)
		}
		request := skillset.PrepareRequest{
			Scope:            "opaque-scope",
			RequestID:        fmt.Sprintf("request-%d", index),
			AgentID:          fmt.Sprintf("agent-%d", index),
			OrganizationID:   organization,
			OwnerOperationID: fmt.Sprintf("owner-%d", index),
			LayoutVersion:    1,
			SkillSetDigest:   digest,
			SystemSkills:     []skillset.FrozenSkill{},
		}
		if _, err := store.AdmitSkillPreparation(ctx, request); err != nil {
			t.Fatalf("admit %q: %v", organization, err)
		}
		receipt, err := store.GetSkillPreparation(ctx, request.Scope, organization, request.AgentID, request.RequestID)
		if err != nil {
			t.Fatalf("get %q: %v", organization, err)
		}
		if receipt.OrganizationID != organization {
			t.Fatalf("organization %q persisted as %q", organization, receipt.OrganizationID)
		}
		if replay, err := store.AdmitSkillPreparation(ctx, request); err != nil || !reflect.DeepEqual(replay, receipt) {
			t.Fatalf("idempotent replay %q: %+v %v", organization, replay, err)
		}
		if other, err := store.GetSkillPreparation(ctx, request.Scope, "isolated-org", request.AgentID, request.RequestID); err == nil {
			t.Fatalf("organization isolation leaked %q: %+v", organization, other)
		}
	}
	for index, organization := range vectors["organizationId"].Reject {
		request := skillset.PrepareRequest{
			Scope:            "reject-scope",
			RequestID:        fmt.Sprintf("reject-request-%d", index),
			AgentID:          fmt.Sprintf("reject-agent-%d", index),
			OrganizationID:   organization,
			OwnerOperationID: fmt.Sprintf("reject-owner-%d", index),
			LayoutVersion:    1,
			SystemSkills:     []skillset.FrozenSkill{},
		}
		if _, err := store.AdmitSkillPreparation(ctx, request); err == nil {
			t.Fatalf("admit accepted rejected organization %q", organization)
		}
		if strings.ContainsRune(organization, 0) {
			continue
		}
		if _, err := database.ExecContext(ctx,
			`UPDATE runtime_controller.skill_sets SET organization_id=$1 WHERE controller_scope=$2 AND agent_id=$3`,
			organization, "opaque-scope", "agent-0"); err == nil {
			t.Fatalf("constraint accepted rejected organization %q", organization)
		}
		if check, err := store.GetSkillPreparation(ctx, "opaque-scope", vectors["organizationId"].Accept[0], "agent-0", "request-0"); err != nil || check.OrganizationID != vectors["organizationId"].Accept[0] {
			t.Fatalf("row escaped its original organization after %q: %+v %v", organization, check, err)
		}
	}
}
