ALTER TABLE runtime_egress.runtime_attachments
    DROP CONSTRAINT runtime_attachments_state_check,
    ADD CONSTRAINT runtime_attachments_state_check
        CHECK (state IN ('closed', 'pending', 'open')),
    ADD CONSTRAINT runtime_attachment_pending_unbound
        CHECK (state <> 'pending' OR (runtime_endpoint IS NULL AND tunnel_key_id IS NULL));
