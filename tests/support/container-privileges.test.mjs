import assert from "node:assert/strict";
import test from "node:test";
import { assertContainerPrivileges } from "./container-privileges.mjs";

function inspection(service) {
  return {
    Config: { User: service === "runtime-egress" ? "0:0" : "1001:1001" },
    HostConfig: {
      CapDrop: ["ALL"],
      CapAdd: service === "runtime-egress" ? ["NET_ADMIN"] : null,
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      GroupAdd: ["998"],
    },
  };
}

test("runtime service inspection accepts their exact hardened profiles", () => {
  for (const name of ["runtime-egress", "runtime-controller"]) {
    for (const option of [
      "no-new-privileges",
      "no-new-privileges:true",
      "no-new-privileges=true",
    ]) {
      const value = inspection(name);
      value.HostConfig.SecurityOpt = [option];
      assertContainerPrivileges(name, value, "998");
    }
  }
});

test("runtime service inspection rejects every widened privilege boundary", () => {
  for (const name of ["runtime-egress", "runtime-controller"]) {
    for (const field of [
      "CapDrop",
      "SecurityOpt",
      "ReadonlyRootfs",
      "CapAdd",
    ]) {
      const value = inspection(name);
      value.HostConfig[field] =
        field === "ReadonlyRootfs"
          ? false
          : field === "CapAdd"
            ? ["NET_RAW"]
            : [];
      assert.throws(
        () => assertContainerPrivileges(name, value, "998"),
        undefined,
        `${name} ${field}`,
      );
    }
  }
  for (const user of ["", "root", "0", "0:0", "00:1001"]) {
    const value = inspection("runtime-controller");
    value.Config.User = user;
    assert.throws(() =>
      assertContainerPrivileges("runtime-controller", value, "998"),
    );
  }
  const value = inspection("runtime-controller");
  value.HostConfig.GroupAdd = [];
  assert.throws(() =>
    assertContainerPrivileges("runtime-controller", value, "998"),
  );
});
