import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const limit = 32 * 1024 * 1024;
export class Frames {
  constructor({ startup = false } = {}) {
    this.startup = startup;
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    assert(chunk.length <= limit);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    assert(this.buffer.length <= limit);
    const output = [];
    while (this.buffer.length >= (this.startup ? 4 : 5)) {
      const length = this.buffer.readUInt32BE(this.startup ? 0 : 1),
        size = length + (this.startup ? 0 : 1);
      assert(
        length >= (this.startup ? 8 : 4) && size <= limit,
        "invalid PostgreSQL frame length",
      );
      if (this.buffer.length < size) break;
      const data = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      if (this.startup) {
        assert.equal(
          data.readUInt32BE(4),
          196608,
          "fixture requires plaintext PostgreSQL v3",
        );
        output.push({ type: "startup", data, body: data.subarray(8) });
        this.startup = false;
      } else
        output.push({
          type: String.fromCharCode(data[0]),
          data,
          body: data.subarray(5),
        });
    }
    return output;
  }
}
class Fields {
  constructor(body) {
    this.body = body;
    this.at = 0;
  }
  take(n) {
    assert(
      n >= 0 && this.at + n <= this.body.length,
      "truncated protocol field",
    );
    const b = this.body.subarray(this.at, this.at + n);
    this.at += n;
    return b;
  }
  string() {
    const end = this.body.indexOf(0, this.at);
    assert(end >= this.at && end - this.at <= 256 * 1024);
    const b = this.take(end - this.at + 1);
    return b.subarray(0, -1).toString("utf8");
  }
  short() {
    return this.take(2).readUInt16BE();
  }
  integer() {
    return this.take(4).readInt32BE();
  }
  end() {
    assert.equal(this.at, this.body.length, "extra protocol fields");
  }
}
const normalize = (sql) => sql.replace(/\s+/g, " ").trim();
const digest = (sql) => createHash("sha256").update(sql).digest("hex");
export class Tracker {
  constructor(selection) {
    this.selection = selection;
    this.statements = new Map();
    this.portals = new Map();
    this.transaction = false;
  }
  action(sql, values) {
    sql = normalize(sql);
    const target = this.selection();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql))
      return { command: sql.toUpperCase() };
    if (!target) return {};
    if (
      /^SELECT\b.*\bFROM acp_sessions WHERE id\s*=\s*\$1 FOR UPDATE$/i.test(sql)
    )
      return { session: values[0] };
    const base = {
      phase: target.phase,
      session_id: target.session_id,
      query_hash: digest(sql),
    };
    if (
      target.phase === "intent" &&
      /^INSERT INTO runs\s*\(/i.test(sql) &&
      values[2] === target.session_id
    )
      return {
        ...base,
        run_id: values[0],
        transactional: true,
        command_tag: "COMMIT",
      };
    if (
      target.phase === "accept" &&
      /^UPDATE runs SET state = 'running', execution_snapshot = \$2::jsonb\b/i.test(
        sql,
      )
    )
      return {
        ...base,
        run_id: values[0],
        transactional: true,
        command_tag: "COMMIT",
      };
    if (
      target.phase === "finish" &&
      /^WITH finished AS \(UPDATE runs\b/i.test(sql) &&
      values[0] === target.run_id &&
      values[1] === "completed"
    )
      return {
        ...base,
        run_id: values[0],
        transactional: false,
        command_tag: "SELECT 1",
      };
    return {};
  }
  apply(action) {
    if (action.command === "BEGIN") {
      this.transaction = true;
      this.session = undefined;
      this.candidate = undefined;
      return;
    }
    if (action.command === "ROLLBACK") {
      this.transaction = false;
      this.session = undefined;
      this.candidate = undefined;
      return;
    }
    if (action.command === "COMMIT") {
      const candidate = this.candidate;
      this.transaction = false;
      this.session = undefined;
      this.candidate = undefined;
      return candidate;
    }
    if (action.session !== undefined && this.transaction) {
      this.session = action.session;
      return;
    }
    if (!action.run_id) return;
    const target = this.selection();
    if (
      !target ||
      target.phase !== action.phase ||
      target.session_id !== action.session_id ||
      (target.run_id !== undefined && target.run_id !== action.run_id)
    )
      return;
    assert.equal(typeof action.run_id, "string");
    assert(action.run_id.length > 0 && action.run_id.length <= 128);
    if (action.transactional) {
      if (
        !this.transaction ||
        (action.phase === "accept" && this.session !== action.session_id) ||
        (this.session !== undefined && this.session !== action.session_id)
      )
        return;
      this.candidate = action;
      return;
    }
    if (!this.transaction && action.run_id === target.run_id) return action;
  }
  observe(frame) {
    if (frame.type === "startup") return;
    const f = new Fields(frame.body);
    if (frame.type === "Q") {
      const sql = f.string();
      f.end();
      this.portals.clear();
      return this.apply(this.action(sql, []));
    }
    if (frame.type === "P") {
      const name = f.string(),
        sql = f.string(),
        count = f.short();
      assert(count <= 1024);
      f.take(count * 4);
      f.end();
      assert(this.statements.size < 64 || this.statements.has(name));
      this.statements.set(name, sql);
      return;
    }
    if (frame.type === "B") {
      const portal = f.string(),
        statement = f.string(),
        formats = f.short();
      assert(formats <= 1024);
      const codes = Array.from({ length: formats }, () => f.short());
      assert(codes.every((c) => c === 0 || c === 1));
      const count = f.short();
      assert(count <= 1024);
      assert(formats === 0 || formats === 1 || formats === count);
      const values = [];
      for (let i = 0; i < count; i++) {
        const size = f.integer();
        assert(size >= -1);
        const value = size === -1 ? null : f.take(size);
        values.push(
          value === null
            ? null
            : (codes.length === 1 ? codes[0] : (codes[i] ?? 0)) === 0 &&
                size <= 256
              ? value.toString("utf8")
              : undefined,
        );
      }
      const results = f.short();
      assert(results <= 1024);
      f.take(results * 2);
      f.end();
      assert(this.statements.has(statement));
      assert(this.portals.size < 64 || this.portals.has(portal));
      this.portals.set(
        portal,
        this.action(this.statements.get(statement), values),
      );
      return;
    }
    if (frame.type === "E") {
      const portal = f.string();
      assert.equal(f.integer(), 0, "fixture requires complete query execution");
      f.end();
      assert(this.portals.has(portal));
      return this.apply(this.portals.get(portal));
    }
    if (frame.type === "C") {
      const kind = f.take(1).toString(),
        name = f.string();
      f.end();
      if (kind === "S") this.statements.delete(name);
      else if (kind === "P") this.portals.delete(name);
      else throw Error("invalid close");
    }
  }
}
export function successfulResult(frames, receipt) {
  const commands = frames.filter((f) => f.type === "C");
  return (
    frames.length > 0 &&
    !frames.some((f) => f.type === "E") &&
    commands.length === 1 &&
    commands[0].body.toString() === receipt.command_tag + "\0" &&
    frames.at(-1).type === "Z" &&
    frames.at(-1).body.equals(Buffer.from("I"))
  );
}
