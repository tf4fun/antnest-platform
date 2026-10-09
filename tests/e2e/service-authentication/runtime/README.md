# Native Runtime instance admission

Run serially from the repository root with NVM Node and installed ACP package
dependencies:

```sh
node tests/e2e/service-authentication/runtime/run.mjs
```

This is an Antnest Runtime owning-service gate. It builds the release and explicit
test-feature images; those builds run Linux unit, contract, component, Clippy and
executor checks. It then starts the actual PID 1 release process with TUN,
root-only receiver and workspace volumes on a test-owned internal Docker network.
There are no host ports. A BoringTun readiness-only fixture verifies encrypted
datagrams and returns authenticated resets; it never forwards traffic. Both
root-only bootstrap files are generated from fresh CSPRNG key pairs.
The probe uses the installed official MCP client as a dependency, without running
ACP, RC, Controller, Identity, Registry or any model provider.

The matrix covers anonymous/all-method mount rejection, duplicate/malformed and
other-instance credentials, RC/ACP route separation, exact Host/port rules, strict
UTF-8/JSON media types, identity-free liveness, executor file/environment isolation,
retained execution fences and signed-ticket requirements. Native tools, learning
install/digest and temporary install/release remain functional, including
multipart artifacts and the optional JSON UTF-8 charset. Restart preserves
workload authority and retires the previous execution fence.

Invalid mode/opt-in/TLS settings, missing bootstrap, digest mismatch, empty/extra
volume contents, wrong owners/modes, symlinks and FIFOs must fail at RuntimeSpec
admission before networking or a listener. This gate does not claim Controller
relay, ACP instance clients or cross-service business acceptance.

Credentials are fresh CSPRNG values in ignored private evidence storage, never
public conformance fixtures. The harness removes only resources carrying its
unique ownership label, generated images and temporary credentials in `finally`.
Logs/results remain under `artifacts/verification/runtime-instance-admission/`.

The same gate also runs two real stdio MCP servers. Their disk cache probes
cover HOME, TMPDIR, XDG configuration/cache and hardcoded `/tmp`; the peer MCP
and normal UID 1000 Bash must fail to read them. The cache owner must remain
able to read its files, with cwd unchanged and default modes 0600. Restart
recreates the private cache tree. World-writable or non-root-owned base mounts
fail before managed programs execute. A focused reproduction is available with
`node tests/e2e/service-authentication/runtime/run.mjs --managed-caches-only`.
