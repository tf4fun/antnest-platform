# Stored-secret encryption

Shared, dependency-free Go implementation of the
[stored-secret rotation contract](../../contracts/platform/encryption-key-rotation.md).
The module owns encryption configuration loading, canonical key-ring parsing,
authenticated version-1 envelopes, legacy `local-v1` decryption, local data-key
wrapping and command argument bounds.
Service adapters supply their existing record identity and own PostgreSQL rows,
transactions, progress and lifecycle configuration. The module imports no service.

`LoadConfig(lookup, prefix, checkKey)` loads the three encryption variables once
and validates their complete structure before invoking the required policy callback
for every key, including decrypt-only members. It supplies the owning single-key
or ring variable name and preserves callback errors and warnings. Services pass
`devsecrets.Policy.CheckKey`; the module does not import `devsecrets` or
`service-authentication` and has no external Go dependencies. Configuration errors
exclude key material; callbacks must follow the same rule. Controller and Identity
consumer replacement is delivered in separate owning-service batches.

`KeyEncrypter` accepts a key ID, data key or wrapped key, and associated data.
It is the extension point for a future remote KMS adapter. No external KMS is
implemented. The current local adapter uses AES-256-GCM, with a separate random
nonce for each wrapping operation. The wrapped key encoding is one version byte
(`1`), a 12-byte nonce and the 48-byte GCM ciphertext/tag for a 32-byte data key.

Payload AAD uses big-endian 32-bit length-prefixed fields: the ASCII format tag
`antnest-envelope-v1`, service purpose, and the service's existing identity bytes.
Wrapping AAD length-prefixes that complete payload AAD and the exact master-key
ID. This binds key labels without preventing re-wrapping of an unchanged payload.
Only NULL wrapped keys with ID `local-v1` use historical, unmodified identity AAD.

Run standalone checks with `GOWORK=off go test -race -count=1 ./...` and
`GOWORK=off go vet ./...`. Tests cover mixed rings, same-key relabeling,
cross-record/service tampering, malformed metadata, legacy conversion, key
retirement, cancellation and command bounds.
