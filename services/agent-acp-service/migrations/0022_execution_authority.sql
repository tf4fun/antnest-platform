ALTER TABLE execution_configurations
  ADD COLUMN authority_version integer,
  ADD COLUMN authority_nonce bytea,
  ADD COLUMN authority_ciphertext bytea,
  ADD CONSTRAINT execution_authority_envelope CHECK (
    (authority_version IS NULL AND authority_nonce IS NULL AND authority_ciphertext IS NULL)
    OR (
      authority_version IS NOT NULL AND authority_version = 1
      AND authority_nonce IS NOT NULL AND octet_length(authority_nonce) = 12
      AND authority_ciphertext IS NOT NULL AND octet_length(authority_ciphertext) >= 16
    )
  );
