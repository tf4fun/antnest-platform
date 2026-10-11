ALTER TABLE oidc_providers
    ADD COLUMN link_policy TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN link_domains TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN authoritative BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN link_policy_review_required BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT oidc_link_policy_valid CHECK (
        link_policy IN ('none', 'verified_email_in_domains', 'verified_email')
    ),
    ADD CONSTRAINT oidc_link_domains_policy CHECK (
        (link_policy = 'verified_email_in_domains' AND cardinality(link_domains) BETWEEN 1 AND 100)
        OR (link_policy <> 'verified_email_in_domains' AND cardinality(link_domains) = 0)
    );

-- Preserve existing member linking, but require explicit review. Admin linking
-- now also requires authoritative=true; historical bindings remain unchanged.
UPDATE oidc_providers
SET link_policy = 'verified_email', link_policy_review_required = true;
