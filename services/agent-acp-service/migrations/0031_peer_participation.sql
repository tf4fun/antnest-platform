-- Operators must stop all previous-version processes AND pending startups
-- before this upgrade. This lock additionally refuses an active old worker;
-- it cannot by itself prove that an old startup will not resume later.
DO $$ BEGIN
    IF NOT pg_try_advisory_xact_lock(2026083002) THEN
        RAISE EXCEPTION 'Retire all ACP workers before enabling participation';
    END IF;
END $$;

CREATE TABLE acp_peer_participation (
    id smallint PRIMARY KEY REFERENCES acp_peer_membership(id) CHECK (id=1),
    revision bigint NOT NULL CHECK (revision>=0)
);
CREATE TABLE acp_peer_participants (
    id smallint NOT NULL REFERENCES acp_peer_participation(id) CHECK (id=1),
    registration_id text PRIMARY KEY CHECK (registration_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    member_id text NOT NULL CHECK (length(member_id) BETWEEN 1 AND 64 AND member_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
    incarnation_id text NOT NULL CHECK (incarnation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    participation_revision bigint NOT NULL UNIQUE CHECK (participation_revision>0),
    UNIQUE (member_id,incarnation_id)
);
CREATE TRIGGER acp_peer_participants_immutable
BEFORE UPDATE OR DELETE ON acp_peer_participants
FOR EACH ROW EXECUTE FUNCTION preserve_acp_peer_membership();
CREATE TRIGGER acp_peer_participants_no_truncate
BEFORE TRUNCATE ON acp_peer_participants
FOR EACH STATEMENT EXECUTE FUNCTION preserve_acp_peer_membership();
