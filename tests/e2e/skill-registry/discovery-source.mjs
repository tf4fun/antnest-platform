import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { skillArtifact } from "./stage3-fixture.mjs";
const org = `org_${"a".repeat(32)}`;
const agent = `agent_${"b".repeat(32)}`;
const owner = `user_${"c".repeat(32)}`;
const token = process.env.SOURCE_TOKEN;
let version = 1,
  sequence = 1,
  active = true,
  unavailable = false;
let artifactReads = 0,
  inspections = 0;
const hash = (value) => createHash("sha256").update(value).digest();
function current() {
  const artifact = skillArtifact(version);
  const file = artifact.subarray(38, 38 + artifact.readUInt32LE(18));
  const path = Buffer.from("SKILL.md");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(path.length);
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(file.length));
  const digest = `sha256:${hash(Buffer.concat([Buffer.from("antnest-skill-manifest-v1\0"), length, path, size, hash(file), Buffer.from([0])])).toString("hex")}`;
  return {
    artifact,
    projection: {
      organization_id: org,
      agent_id: agent,
      owner_id: owner,
      name: "code-review",
      description: "Review code",
      sequence,
      content_digest: digest,
      active,
    },
  };
}
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    assert(size <= 8192);
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts));
}
if (process.argv.includes("--healthcheck")) {
  const response = await fetch("http://127.0.0.1:8080/status", {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
} else {
  assert(token?.length >= 32);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/status") return json(res, 200, { status: "ok" });
      if (req.url === "/fixture/state") {
        if (req.method === "POST") {
          const next = await body(req);
          if (next.version !== undefined) {
            assert([1, 2].includes(next.version));
            version = next.version;
          }
          if (next.sequence !== undefined) sequence = next.sequence;
          if (next.active !== undefined) active = next.active;
          if (next.unavailable !== undefined) unavailable = next.unavailable;
        }
        return json(res, 200, {
          ...current().projection,
          artifact_reads: artifactReads,
          inspections,
        });
      }
      if (req.headers.authorization !== `Bearer ${token}`)
        return json(res, 401, {
          error: {
            code: "unauthorized",
            message: "Source reader authentication required",
          },
        });
      if (unavailable)
        return json(res, 503, {
          error: {
            code: "source_unavailable",
            message: "Fixture source offline",
          },
        });
      const input = await body(req);
      const { artifact, projection } = current();
      const readable =
        input.organization_id === org && input.actor_id === owner && active;
      if (req.url === "/internal/skill-sources/inspect") {
        inspections++;
        const selected = input.sources.some(
          (key) => key.agent_id === agent && key.name === projection.name,
        );
        return json(res, 200, {
          items: readable && selected ? [projection] : [],
        });
      }
      if (req.url === "/internal/skill-sources/artifact") {
        artifactReads++;
        if (
          !readable ||
          input.skill_ref.agent_id !== agent ||
          input.skill_ref.name !== projection.name
        )
          return json(res, 404, {
            error: { code: "not_found", message: "Source not readable" },
          });
        if (
          input.skill_ref.sequence !== sequence ||
          input.expected_digest !== projection.content_digest
        )
          return json(res, 409, {
            error: {
              code: "content_changed",
              message: "Choose current content",
            },
          });
        const artifactDigest = `sha256:${hash(artifact).toString("hex")}`;
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": artifact.length,
          ETag: `"${artifactDigest}"`,
          "X-Antnest-Artifact-Digest": artifactDigest,
          "X-Antnest-Content-Digest": projection.content_digest,
          "X-Antnest-Source-Sequence": String(sequence),
        });
        return res.end(artifact);
      }
      json(res, 404, {
        error: { code: "not_found", message: "Missing fixture route" },
      });
    } catch {
      json(res, 400, {
        error: { code: "invalid_request", message: "Invalid fixture request" },
      });
    }
  });
  server.listen(8080, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
}
