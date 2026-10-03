# Controller authentication acceptance

Run serially from the repository root with NVM Node:

~~~sh
node tests/e2e/service-authentication/controller/run.mjs
~~~

The harness builds the real Controller image, uses isolated official PostgreSQL
and Temporal, and generates private CSPRNG service credentials and an Ed25519
Identity fixture. Dependency doubles reject missing credentials and untrusted
user headers. Checks cover native admission, signed scope, strict JSON, catalog
writes, unchanged Registry CCT, ACP control publication, custom-port health,
startup rejection, normal SIGTERM/SIGINT and restart. The separate Go component
gate exercises all five concrete dependency clients, including Egress and token
rotation. These owning-service checks do not claim cross-service acceptance.

The project, volumes, networks and private credentials are cleaned in finally;
only bounded results and redacted failure diagnostics remain under ignored
artifacts/verification/.
No real Provider credentials or model inference are used.
