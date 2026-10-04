# Runtime status and test features

`GET /status` follows [runtime-status.schema.json](runtime-status.schema.json).
It requires RC-issued Runtime workload authority and permits only RC and ACP.
Anonymous Docker health uses `GET/HEAD /status/live`, which returns only `status`
with 200/503 and never exposes Agent, generation, execution or tool identity.
See the [instance connection contract](instance-connection.md). Full identity
verification must not use the reduced liveness response.
The `test_features` array is mandatory in Runtime responses, including unavailable
responses. Its values come from the binary's compiled features, never from an
HTTP parameter or an environment-provided list. Release builds report `[]`.

A binary with compiled test features must reject `serve` before normal bootstrap
unless `ANTNEST_RUNTIME_ALLOW_TEST_FEATURES` is exactly `true`. If permitted, it
must emit one startup warning listing those features. The opt-in is not trimmed
or case-normalized and cannot enable features absent from the binary.

The Runtime Dockerfile's default, final target is `release`. Its build must not
read `ANTNEST_RUNTIME_FEATURES` or pass `--features`. Tests that need the commit
pause must explicitly select `--target e2e` and supply the feature build argument.
The `dev.antnest.runtime.test-features` image label is empty on release images;
E2E images record the selected test features and explicitly enable startup.

Deploy the Runtime Controller status reader before the new Runtime images:
older readers reject the added JSON field. Recognizing `test_features`
does not implement image admission; rejecting test images outside test
deployments remains [#29](https://github.com/tf4fun/antnest-platform/issues/29).

Delivery batches for [#12](https://github.com/tf4fun/antnest-platform/issues/12):

| Owner              | Work                                                              | State                              |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------- |
| Shared contract    | Status schema and release/E2E examples                            | Complete; schema tests pass        |
| Runtime            | Separate image targets, startup guard/warning and status metadata | Complete; both build gates pass    |
| Runtime Controller | Recognize the status field while keeping strict decoding          | Complete; local service gates pass |
| Integration        | Default image and held-commit Docker regressions                  | Complete; both Docker E2E pass     |
