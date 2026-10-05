import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const binary = (value) => `decode(${quote(value.toString("base64"))},'base64')`;

// Reproduce the pre-envelope format using only a disposable fixture's own key
// and freshly generated synthetic data. No deployed credential is inspected.
export async function seedLegacyOIDCSecrets({ sql, key, organizationID }) {
  const providerID = `rotation-provider-${randomUUID()}`;
  const sessionID = `rotation-session-${randomUUID()}`;
  const name = "rotation-fixture";
  const seal = (plaintext, identity) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      nonce,
    );
    cipher.setAAD(Buffer.from(identity));
    return {
      nonce,
      ciphertext: Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
    };
  };
  const provider = seal(
    randomBytes(32),
    `oidc-provider\0${organizationID}\0${name}`,
  );
  const session = seal(
    Buffer.from(
      JSON.stringify({ nonce: randomUUID(), code_verifier: randomUUID() }),
    ),
    sessionID,
  );
  await sql(`INSERT INTO oidc_providers
    (id, organization_id, name, display_name, issuer, client_id,
     client_secret_ciphertext, client_secret_nonce, scopes, enabled, revision,
     authorization_endpoint, token_endpoint, token_endpoint_auth_method,
     id_token_signing_algs, jwks_uri, created_at, updated_at)
    VALUES (${quote(providerID)}, ${quote(organizationID)}, ${quote(name)},
     'Synthetic rotation fixture', 'https://rotation.invalid', 'fixture-client',
     ${binary(provider.ciphertext)}, ${binary(provider.nonce)}, ARRAY['openid'], false, 1,
     'https://rotation.invalid/authorize', 'https://rotation.invalid/token',
     'client_secret_basic', ARRAY['RS256'], 'https://rotation.invalid/jwks', now(), now());
    INSERT INTO oidc_auth_sessions
    (id, provider_id, organization_id, provider_revision, state_hash, request_id,
     status, secret_ciphertext, secret_nonce, expires_at, created_at, updated_at)
    VALUES (${quote(sessionID)}, ${quote(providerID)}, ${quote(organizationID)}, 1,
     ${quote(randomBytes(32).toString("hex"))}, ${quote(randomUUID())}, 'pending',
     ${binary(session.ciphertext)}, ${binary(session.nonce)}, now()+interval '1 hour', now(), now());`);
}

export const oidcBusinessFingerprintSQL = `SELECT md5(
  (SELECT jsonb_agg(to_jsonb(p) - 'client_secret_ciphertext' - 'client_secret_nonce'
    - 'client_secret_key_id' - 'client_secret_wrapped_data_key' ORDER BY id)::text FROM oidc_providers p)
  || (SELECT jsonb_agg(to_jsonb(s) - 'secret_ciphertext' - 'secret_nonce'
    - 'secret_key_id' - 'secret_wrapped_data_key' ORDER BY id)::text FROM oidc_auth_sessions s))`;

export function parseRekeyProgress(output, activeKID, tables) {
  const progress = output.split("\n").map((line) => JSON.parse(line));
  if (!progress.every((row) => row.active_kid === activeKID))
    throw new Error("rekey reported a different active key");
  for (const table of tables) {
    const final = progress.filter((row) => row.table === table).at(-1);
    if (!final || final.remaining !== 0 || final.updated !== 0)
      throw new Error("rekey did not complete every owned table");
  }
  return progress.reduce((sum, row) => sum + row.updated, 0);
}
