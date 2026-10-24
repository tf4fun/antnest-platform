-- One ACP database has one peer roster. A new cluster id must not create a
-- second namespace that forgets old registrations or access holders.
CREATE TABLE acp_peer_membership (
    id smallint PRIMARY KEY CHECK (id = 1),
    cluster_id text NOT NULL CHECK (cluster_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    membership_sha256 text NOT NULL CHECK (membership_sha256 ~ '^[0-9a-f]{64}$'),
    catalog jsonb NOT NULL,
    pinned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((
        jsonb_typeof(catalog) = 'object'
        AND catalog ?& ARRAY['version','cluster_id','members']
        AND catalog - ARRAY['version','cluster_id','members'] = '{}'::jsonb
        AND catalog->'version' = '1'::jsonb
        AND jsonb_typeof(catalog->'cluster_id') = 'string'
        AND catalog->>'cluster_id' = cluster_id
        AND jsonb_typeof(catalog->'members') = 'array'
        AND jsonb_array_length(catalog->'members') BETWEEN 1 AND 64
    ) IS TRUE)
);

CREATE FUNCTION preserve_acp_peer_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACP peer membership is immutable';
END;
$$;

CREATE TRIGGER acp_peer_membership_immutable
BEFORE UPDATE OR DELETE ON acp_peer_membership
FOR EACH ROW EXECUTE FUNCTION preserve_acp_peer_membership();

CREATE TRIGGER acp_peer_membership_no_truncate
BEFORE TRUNCATE ON acp_peer_membership
FOR EACH STATEMENT EXECUTE FUNCTION preserve_acp_peer_membership();
