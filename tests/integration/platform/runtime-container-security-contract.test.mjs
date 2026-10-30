import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

function readContract() {
  const file = new URL("contracts/runtime/container-security.json", root);
  assert(existsSync(file), "missing runtime container security contract");
  return JSON.parse(readFileSync(file, "utf8"));
}

const deniedSyscalls = [
  "keyctl",
  "bpf",
  "perf_event_open",
  "userfaultfd",
  "mount",
];

test("the published contract is advertised after every owning service batch delivered", () => {
  const contract = readContract();
  assert.equal(contract.contract, "antnest.runtime.container-security");
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.status, "published");
  assert.equal(contract.issue, 35);
  assert.deepEqual(contract.delivery_batches, [
    "antnest-runtime",
    "runtime-controller",
    "agent-controller",
    "admin-console",
    "integration",
  ]);
  assert.equal(
    contract.docker_e2e,
    "dedicated-workflow-not-a-development-follow-up",
  );
  const active = JSON.parse(
    readFileSync(new URL("contracts/runtime/contract.json", root), "utf8"),
  );
  assert.equal(active.container_security, "container-security.json");
});

test("resource properties bound cpu and workspace and stay producer-compatible", () => {
  const { resource_properties: resources } = readContract();
  assert.equal(resources.container, "deployment.resources");
  assert.deepEqual(resources.legacy_fields.names, [
    "memory_bytes",
    "pids_limit",
    "tmpfs_bytes",
  ]);
  assert.equal(resources.legacy_fields.policy, "remain-compatible");
  assert.deepEqual(resources.definitions.cpu_millis, {
    type: "integer",
    minimum: 100,
    maximum: 16000,
    default: 1000,
  });
  assert.deepEqual(resources.definitions.workspace_bytes, {
    type: "integer",
    minimum: 67108864,
    maximum: 1099511627776,
    default: 10737418240,
  });
  for (const [name, definition] of Object.entries(resources.definitions)) {
    assert(definition.minimum > 0, `${name} must reject explicit zero`);
    assert(
      definition.default >= definition.minimum &&
        definition.default <= definition.maximum,
      `${name} default must stay in range`,
    );
  }
  const compatibility = resources.compatibility;
  assert.equal(compatibility.additional_fields, "optional");
  assert.equal(compatibility.n_minus_1_producers, "accepted");
  assert.equal(compatibility.omitted_fields, "apply-default");
  assert.equal(compatibility.explicit_zero, "rejected");
  assert.equal(compatibility.out_of_range, "rejected");
});

test("the shutdown budget is ordered and stays inside the engine stop grace", () => {
  const { shutdown } = readContract();
  assert.equal(shutdown.drain_seconds, 8);
  assert.equal(shutdown.cleanup_seconds, 3);
  assert.equal(shutdown.telemetry_seconds, 5);
  assert.equal(shutdown.total_seconds, 16);
  assert.equal(shutdown.stop_grace_seconds, 20);
  assert.equal(
    shutdown.drain_seconds +
      shutdown.cleanup_seconds +
      shutdown.telemetry_seconds,
    shutdown.total_seconds,
  );
  assert(shutdown.total_seconds < shutdown.stop_grace_seconds);
  assert.equal(shutdown.managed_shutdown.parallel_with_drain, true);
  assert.equal(shutdown.managed_shutdown.budget_seconds, 8);
  assert(shutdown.managed_shutdown.budget_seconds <= shutdown.drain_seconds);
  assert.equal(
    shutdown.cleanup_budget_scope,
    "executor-and-io-join-not-only-tool-timeout",
  );
});

test("filesystem, capabilities and seccomp pin the isolation contract", () => {
  const contract = readContract();
  const filesystem = contract.filesystem;
  assert.equal(filesystem.readonly_rootfs, true);
  assert.equal(filesystem.tmp_noexec, true);
  assert.equal(filesystem.run_tmpfs_bytes, 16777216);
  assert.equal(filesystem.workspace, "persistent");
  assert.equal(
    filesystem.managed_mcp_home.kind,
    "separately-bounded-exec-tmpfs",
  );
  assert.equal(filesystem.managed_mcp_home.exec, true);
  assert.equal(
    filesystem.managed_mcp_home.reason,
    "package-tools-require-exec",
  );
  const capabilities = contract.capabilities;
  assert.equal(capabilities.policy, "drop-all-then-add");
  assert.deepEqual(capabilities.set, [
    "CHOWN",
    "DAC_OVERRIDE",
    "KILL",
    "NET_ADMIN",
    "SETGID",
    "SETPCAP",
    "SETUID",
  ]);
  assert.equal(capabilities.removal_claimed, false);
  assert.match(capabilities.setpcap_rationale, /PR_CAPBSET_DROP/);
  assert.match(capabilities.setpcap_rationale, /bounding set empty/);
  assert.match(capabilities.dac_override_rationale, /cross-UID 0700/);
  const seccomp = contract.seccomp;
  assert.equal(seccomp.base, "docker-default-allowlist");
  for (const name of deniedSyscalls)
    assert(seccomp.deny_syscalls_at_least.includes(name), name);
});

test("cpu mapping and disk backend semantics reject unverifiable quota", () => {
  const contract = readContract();
  assert.equal(contract.cpu.nano_cpus, "cpu_millis*1000000");
  assert.equal(contract.cpu.cpu_shares, "max(2,cpu_millis*1024/1000)");
  const disk = contract.disk;
  assert.equal(disk.default_backend.kind, "local-persistent-volume");
  assert.equal(disk.default_backend.workspace_bounded, false);
  assert.equal(disk.default_backend.disk_quota_enforced, false);
  assert.equal(disk.quota_backend.kind, "external-volume-driver");
  assert.equal(
    disk.quota_backend.driver_trust,
    "operator-configured-size-enforcing-driver",
  );
  assert.equal(
    disk.quota_backend.size_option,
    "operator-chosen-name-with-decimal-bytes-value",
  );
  assert.equal(disk.quota_backend.arbitrary_driver_enforces_size, false);
  assert.equal(disk.verification, "inspect-driver-and-options-must-match");
  assert.equal(
    disk.existing_volume,
    "reject-unbounded-or-mismatched-quota-never-silently-migrate",
  );
  assert.equal(disk.storage_opt_size, "root-image-layer-only-never-workspace");
});
