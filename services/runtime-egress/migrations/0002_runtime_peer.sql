ALTER TABLE runtime_egress.runtime_attachments
    ADD COLUMN runtime_endpoint INET,
    ADD CONSTRAINT runtime_attachment_peer_ipv4
        CHECK (runtime_endpoint IS NULL OR (family(runtime_endpoint) = 4 AND masklen(runtime_endpoint) = 32));
