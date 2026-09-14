CREATE TABLE execution_configurations (
    organization_id text PRIMARY KEY,
    revision bigint NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
    configuration jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        jsonb_typeof(configuration) = 'object'
        AND configuration ?& ARRAY['organization_id', 'revision']
        AND jsonb_typeof(configuration->'organization_id') = 'string'
        AND configuration->>'organization_id' = organization_id
        AND jsonb_typeof(configuration->'revision') = 'number'
        AND (configuration->>'revision')::numeric = revision
    ),
    CHECK (NOT jsonb_path_exists(configuration, '$.providers[*].credential'))
);
