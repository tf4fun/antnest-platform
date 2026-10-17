import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./access-resources.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const run = (...args) => {
  assert.equal(typeof implementation.withCloseoutResources, "function");
  return implementation.withCloseoutResources(...args);
};
test("Closeout joins cleanup before preserving the original business and cleanup failures", async () => {
  const business = new Error("private business"),
    cleanup = new Error("private cleanup");
  const order = [],
    archived = [];
  await assert.rejects(
    () =>
      run(
        async () => {
          order.push("action");
          throw business;
        },
        async () => {
          await Promise.resolve();
          order.push("joined");
          throw cleanup;
        },
        async (error) => {
          order.push("archived");
          archived.push(error);
        },
      ),
    (error) => {
      assert.deepEqual(error.errors, [business, cleanup]);
      assert.equal(archived[0], error);
      return true;
    },
  );
  assert.deepEqual(order, ["action", "joined", "archived"]);
});
test("Closeout retains both original failure and private archive failure", async () => {
  const business = new Error("private business"),
    storage = new Error("private storage");
  let joined = false;
  await assert.rejects(
    () =>
      run(
        async () => {
          throw business;
        },
        async () => {
          joined = true;
        },
        async (error) => {
          assert.equal(error, business);
          throw storage;
        },
      ),
    (error) => {
      assert.deepEqual(error.errors, [business, storage]);
      return true;
    },
  );
  assert.equal(joined, true);
});
test("Closeout retains all three failures after attempting cleanup and preservation", async () => {
  const errors = [
    new Error("business"),
    new Error("cleanup"),
    new Error("storage"),
  ];
  await assert.rejects(
    () =>
      run(
        () => {
          throw errors[0];
        },
        () => {
          throw errors[1];
        },
        () => {
          throw errors[2];
        },
      ),
    (error) => {
      assert.deepEqual(error.errors, errors);
      return true;
    },
  );
});
test("a cleanup failure makes an otherwise successful Closeout fail", async () => {
  const cleanup = new Error("cleanup"),
    archived = [];
  await assert.rejects(
    () =>
      run(
        () => 42,
        () => {
          throw cleanup;
        },
        (e) => archived.push(e),
      ),
    (e) => e === cleanup,
  );
  assert.deepEqual(archived, [cleanup]);
});
test("successful Closeout joins cleanup without writing failure evidence", async () => {
  const order = [];
  const result = await run(
    () => {
      order.push("business");
      return 42;
    },
    () => order.push("cleanup"),
    () => assert.fail("unexpected failure archive"),
  );
  assert.equal(result, 42);
  assert.deepEqual(order, ["business", "cleanup"]);
});
