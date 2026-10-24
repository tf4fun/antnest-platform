package postgres

const acpIncarnationHistorySQL = `
CREATE TABLE runtime_controller.acp_incarnation_histories (
    controller_scope TEXT NOT NULL CHECK (length(controller_scope) BETWEEN 1 AND 200 AND btrim(controller_scope)=controller_scope),
    member_id TEXT NOT NULL CHECK (length(member_id) BETWEEN 1 AND 64 AND member_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
    history_id TEXT NOT NULL UNIQUE CHECK (history_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    revision BIGINT NOT NULL CHECK (revision >= 0),
    PRIMARY KEY (controller_scope,member_id)
);

ALTER TABLE runtime_controller.acp_incarnation_registrations ADD COLUMN history_sequence BIGINT;

INSERT INTO runtime_controller.acp_incarnation_histories(controller_scope,member_id,history_id,revision)
SELECT controller_scope,member_id,gen_random_uuid()::text,count(*)
FROM runtime_controller.acp_incarnation_registrations GROUP BY controller_scope,member_id;

WITH original AS (
    SELECT controller_scope,registration_id,
        row_number() OVER(PARTITION BY controller_scope,member_id ORDER BY registration_id COLLATE "C") AS sequence
    FROM runtime_controller.acp_incarnation_registrations
)
UPDATE runtime_controller.acp_incarnation_registrations r SET history_sequence=original.sequence
FROM original WHERE r.controller_scope=original.controller_scope AND r.registration_id=original.registration_id;

ALTER TABLE runtime_controller.acp_incarnation_registrations
    ALTER COLUMN history_sequence SET NOT NULL,
    ADD CONSTRAINT acp_incarnation_history_sequence_positive CHECK (history_sequence > 0),
    ADD CONSTRAINT acp_incarnation_history_sequence_unique UNIQUE (controller_scope,member_id,history_sequence),
    ADD CONSTRAINT acp_incarnation_history_head FOREIGN KEY(controller_scope,member_id)
        REFERENCES runtime_controller.acp_incarnation_histories(controller_scope,member_id);
`
