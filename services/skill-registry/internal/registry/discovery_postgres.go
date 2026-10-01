package registry

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) UpsertProjection(ctx context.Context, p Projection) (ProjectionResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ProjectionResult{}, databaseError(err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	command, err := tx.Exec(ctx, `INSERT INTO skill_projections
 (organization_id,agent_id,name,owner_id,description,sequence,content_digest,active)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
		p.OrganizationID, p.AgentID, p.Name, p.OwnerID, p.Description, p.Sequence, p.ContentDigest, p.Active)
	if err != nil {
		return ProjectionResult{}, databaseError(err)
	}
	if command.RowsAffected() == 0 {
		var old Projection
		err = tx.QueryRow(ctx, `SELECT organization_id,agent_id,name,owner_id,description,sequence,content_digest,active
   FROM skill_projections WHERE organization_id=$1 AND agent_id=$2 AND name=$3 FOR UPDATE`,
			p.OrganizationID, p.AgentID, p.Name).Scan(&old.OrganizationID, &old.AgentID, &old.Name, &old.OwnerID, &old.Description, &old.Sequence, &old.ContentDigest, &old.Active)
		if err != nil {
			return ProjectionResult{}, databaseError(err)
		}
		if p.Sequence < old.Sequence {
			return ProjectionResult{Outcome: "superseded", Sequence: old.Sequence}, nil
		}
		if p.Sequence == old.Sequence {
			if p != old {
				return ProjectionResult{}, failure("request_conflict", "source sequence was used with different metadata")
			}
			return ProjectionResult{Outcome: "replayed", Sequence: old.Sequence}, nil
		}
		_, err = tx.Exec(ctx, `UPDATE skill_projections SET owner_id=$4,description=$5,sequence=$6,content_digest=$7,active=$8
   WHERE organization_id=$1 AND agent_id=$2 AND name=$3`, p.OrganizationID, p.AgentID, p.Name, p.OwnerID, p.Description, p.Sequence, p.ContentDigest, p.Active)
		if err != nil {
			return ProjectionResult{}, databaseError(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return ProjectionResult{}, databaseError(err)
	}
	return ProjectionResult{Outcome: "applied", Sequence: p.Sequence}, nil
}
func (s *PostgresStore) GetProjection(ctx context.Context, org, agent, name string) (Projection, error) {
	var p Projection
	err := s.pool.QueryRow(ctx, `SELECT organization_id,agent_id,name,owner_id,description,sequence,content_digest,active
 FROM skill_projections WHERE organization_id=$1 AND agent_id=$2 AND name=$3`, org, agent, name).
		Scan(&p.OrganizationID, &p.AgentID, &p.Name, &p.OwnerID, &p.Description, &p.Sequence, &p.ContentDigest, &p.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return Projection{}, failure("not_found", "Skill source not found")
	}
	return p, databaseError(err)
}
func (s *PostgresStore) SearchCandidates(ctx context.Context, in SearchInput) ([]DiscoveryItem, error) {
	rows, err := s.pool.Query(ctx, `SELECT kind,agent_id,source_name,sequence,skill_id,version,name,description,content_digest FROM (
 SELECT 'agent' AS kind,agent_id,name AS source_name,sequence,'' AS skill_id,0::bigint AS version,name,description,content_digest
 FROM skill_projections WHERE organization_id=$1 AND owner_id=$2 AND active
 AND ($5='' OR agent_id<>$5)
 AND strpos(lower(name || ' ' || description),lower($3))>0
 UNION ALL
 SELECT 'registry','' AS agent_id,'' AS source_name,0::bigint AS sequence,s.skill_id,s.current_version,
 s.name,v.metadata->>'description',v.metadata->>'content_digest'
 FROM skills s JOIN skill_versions v ON v.skill_id=s.skill_id AND v.version=s.current_version
 WHERE s.organization_id=$1 AND strpos(lower(s.name || ' ' || (v.metadata->>'description')),lower($3))>0
 ) candidates ORDER BY name COLLATE "C",kind COLLATE "C",agent_id COLLATE "C",skill_id COLLATE "C" LIMIT $4`,
		in.OrganizationID, in.ActorID, in.Query, in.Limit, in.RequestingAgentID)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	out := make([]DiscoveryItem, 0, in.Limit)
	for rows.Next() {
		var item DiscoveryItem
		if err := rows.Scan(&item.SkillRef.Kind, &item.SkillRef.AgentID, &item.SkillRef.Name, &item.SkillRef.Sequence, &item.SkillRef.SkillID, &item.SkillRef.Version, &item.Name, &item.Description, &item.ContentDigest); err != nil {
			return nil, databaseError(err)
		}
		out = append(out, item)
	}
	return out, databaseError(rows.Err())
}
