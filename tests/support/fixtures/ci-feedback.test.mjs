import {
  test,
  expect,
} from "../../../services/agent-acp-service/node_modules/vitest/dist/index.js";

test("component failure feedback probe", () => {
  expect(process.env.ANTNEST_FEEDBACK_CANARY).toBe("intentionally different");
});
