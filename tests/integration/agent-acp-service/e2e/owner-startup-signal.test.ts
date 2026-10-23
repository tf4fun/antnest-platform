import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import {
  createConnection,
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OwnerRegistrationRequest } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  authenticateFields,
  fields,
} from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import {
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";

const servicePackage = new URL(
  "../../../../services/agent-acp-service/package.json",
  import.meta.url,
);
const memberId = "acp-startup-signal";
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Probe = {
  result: Promise<Outcome<{ status: number; body: Buffer }>>;
  abort(): void;
  join(): Promise<void>;
};

// A deadline reports a failure; the finally block still stops and joins the
// original child, requests, handlers and sockets rather than abandoning them.
async function bounded<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 3000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server: Server): Promise<number> {
  await bounded(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }),
    "fixture listener",
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture listener has no TCP address");
  return address.port;
}

function closeListener(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function expectConnectionRefused(port: number): Promise<void> {
  const result = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => result.resolve("connected"));
  socket.once("error", (error: NodeJS.ErrnoException) =>
    result.resolve(error.code ?? "unknown"),
  );
  socket.once("close", () => closed.resolve());
  let observed: string;
  try {
    observed = await bounded(result.promise, "connection refusal");
  } finally {
    socket.destroy();
    await closed.promise;
  }
  expect(observed).toBe("ECONNREFUSED");
}

function sendProbe(
  port: number,
  input: OwnerRegistrationRequest,
  challenge: string,
): Probe {
  const body = JSON.stringify({ ...input, challenge });
  const result =
    Promise.withResolvers<Outcome<{ status: number; body: Buffer }>>();
  const requestClosed = Promise.withResolvers<void>();
  let responseClosed = Promise.resolve();
  let socketClosed = Promise.resolve();
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/internal/acp-owner/incarnation/probe",
    agent: false,
    headers: {
      ...workloadHeaders("runtime-controller"),
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    },
  });
  request.once("socket", (socket) => {
    const closed = Promise.withResolvers<void>();
    socketClosed = closed.promise;
    socket.once("close", () => closed.resolve());
  });
  request.once("response", (response) => {
    const closed = Promise.withResolvers<void>();
    responseClosed = closed.promise;
    response.once("close", () => closed.resolve());
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("error", (error) => result.resolve({ ok: false, error }));
    response.once("aborted", () =>
      result.resolve({
        ok: false,
        error: new Error("Owner probe response aborted"),
      }),
    );
    response.once("end", () => {
      if (!response.complete) {
        result.resolve({
          ok: false,
          error: new Error("Owner probe response incomplete"),
        });
        return;
      }
      result.resolve({
        ok: true,
        value: { status: response.statusCode!, body: Buffer.concat(chunks) },
      });
    });
  });
  request.once("error", (error) => result.resolve({ ok: false, error }));
  request.once("close", () => {
    result.resolve({
      ok: false,
      error: new Error("Owner probe closed without a complete response"),
    });
    requestClosed.resolve();
  });
  request.end(body);
  return {
    result: result.promise,
    abort: () =>
      request.destroy(new Error("Owner startup signal fixture cleanup")),
    async join() {
      await requestClosed.promise;
      await responseClosed;
      await socketClosed;
    },
  };
}

describe("owner incarnation main process cancellation", () => {
  it("joins held registration and closes the early probe on SIGTERM before ordinary startup", async () => {
    const failures: unknown[] = [];
    const reservations: Server[] = [];
    const reservationCloses = new Map<Server, Promise<void>>();
    const sockets = new Set<Socket>();
    const socketCloses: Promise<void>[] = [];
    const requestCloses: Promise<void>[] = [];
    const responseCloses: Promise<void>[] = [];
    const handlers: Promise<void>[] = [];
    const probes: Probe[] = [];
    const held = Promise.withResolvers<Outcome<void>>();
    const exited = Promise.withResolvers<Exit>();
    const closed = Promise.withResolvers<Exit>();
    const environment = testSecurityEnvironment();
    const token = readFileSync(
      join(environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR, "runtime-controller"),
      "utf8",
    );
    const receiver = new Map([
      [
        `sha256:${createHash("sha256").update(token).digest("hex")}`,
        "agent-acp-service",
      ],
    ]);
    const sensitive = new Set([
      token,
      ...Object.values(workloadHeaders("runtime-controller")),
    ]);
    let child: ChildProcess | undefined;
    let childExit: Exit | undefined;
    let childClose: Exit | undefined;
    const childHasClosed = (): boolean => childClose !== undefined;
    let stderr = "";
    let ownerPort = 0;
    let registrations = 0;
    let handlersFinished = 0;
    let receiptFinished = false;
    const server = createServer((request, response) => {
      const requestClosed = Promise.withResolvers<void>();
      const responseClosed = Promise.withResolvers<void>();
      requestCloses.push(requestClosed.promise);
      responseCloses.push(responseClosed.promise);
      request.once("close", () => requestClosed.resolve());
      response.once("close", () => responseClosed.resolve());
      response.once("finish", () => {
        receiptFinished = true;
      });
      const task = (async () => {
        registrations++;
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/internal/acp-incarnations/register");
        const admission = authenticateFields(receiver, fields(request), [
          "agent-acp-service",
        ]);
        expect(
          admission.code,
          "RC registration must carry the actual ACP workload credential",
        ).toBeNull();
        expect(admission.caller).toBe("agent-acp-service");
        for (const name of [
          "authorization",
          "cookie",
          "antnest-caller-context",
        ])
          expect(request.headers[name]).toBeUndefined();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const data = chunk as Buffer;
          bytes += data.byteLength;
          if (bytes > 4096)
            throw new Error("Registration exceeded its request budget");
          chunks.push(data);
        }
        const input = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as OwnerRegistrationRequest;
        expect(Object.keys(input).sort()).toEqual([
          "incarnation_id",
          "member_id",
          "registration_nonce",
        ]);
        expect(input.member_id).toBe(memberId);
        expect(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            input.incarnation_id,
          ),
        ).toBe(true);
        expect(/^[0-9a-f]{64}$/u.test(input.registration_nonce)).toBe(true);
        const challenge = randomBytes(32).toString("hex");
        sensitive.add(input.registration_nonce);
        sensitive.add(challenge);
        const probe = sendProbe(ownerPort, input, challenge);
        probes.push(probe);
        const probed = await bounded(
          probe.result,
          "authenticated startup probe",
        );
        await bounded(
          probe.join(),
          "original startup probe request and socket close",
        );
        if (!probed.ok) throw probed.error;
        expect(probed.value.status).toBe(200);
        const echoed = JSON.parse(probed.value.body.toString("utf8")) as Record<
          string,
          unknown
        >;
        expect(Object.keys(echoed).sort()).toEqual([
          "challenge",
          "incarnation_id",
          "member_id",
          "registration_nonce",
        ]);
        expect(echoed.member_id === input.member_id).toBe(true);
        expect(echoed.incarnation_id === input.incarnation_id).toBe(true);
        expect(echoed.registration_nonce === input.registration_nonce).toBe(
          true,
        );
        expect(echoed.challenge === challenge).toBe(true);
        const receipt = JSON.stringify({
          registration_id: randomUUID(),
          member_id: input.member_id,
          incarnation_id: input.incarnation_id,
        });
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(receipt),
          Connection: "close",
        });
        await new Promise<void>((resolve, reject) => {
          response.write(receipt.slice(0, -1), (error) =>
            error == null ? resolve() : reject(error),
          );
        });
        held.resolve({ ok: true, value: undefined });
        // The withheld final byte is never sent, including during cleanup.
        // Only actual cancellation/connection close releases this handler.
        await responseClosed.promise;
      })()
        .catch((error: unknown) => {
          failures.push(error);
          held.resolve({ ok: false, error });
          response.destroy();
          request.destroy();
        })
        .finally(() => {
          handlersFinished++;
        });
      handlers.push(task);
    });
    server.on("error", (error) => failures.push(error));
    server.on("connection", (socket) => {
      sockets.add(socket);
      socketCloses.push(
        new Promise<void>((resolve) => {
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          });
        }),
      );
    });
    const releaseReservations = async (): Promise<void> => {
      const results = await Promise.allSettled(
        reservations.map((server) => {
          let closing = reservationCloses.get(server);
          if (closing === undefined) {
            closing = closeListener(server);
            reservationCloses.set(server, closing);
          }
          return closing;
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length !== 0)
        throw new AggregateError(errors, "Port reservations did not close");
    };
    try {
      const rcPort = await listen(server);
      const ports: number[] = [];
      for (let index = 0; index < 4; index++) {
        const reservation = createTcpServer();
        reservations.push(reservation);
        ports.push(await listen(reservation));
      }
      ownerPort = ports[0]!;
      const workspacePort = ports[1]!;
      const controlPort = ports[2]!;
      const databasePort = ports[3]!;
      const childEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ...environment,
        // Reuse the child fixture's runtime-only tsconfig, without service
        // declaration-file aliases, and run main itself without a test shim.
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL("../support/run-intent-child.tsconfig.json", import.meta.url),
        ),
        ANTNEST_ACP_DATABASE_URL: `postgres://startup:synthetic@127.0.0.1:${databasePort}/owner_startup_signal_test`,
        ANTNEST_ACP_DATABASE_TIMEOUT: "500ms",
        ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from(
          "0123456789abcdef0123456789abcdef",
        ).toString("base64"),
        ANTNEST_ACP_LISTEN: `127.0.0.1:${workspacePort}`,
        ANTNEST_ACP_CONTROL_LISTEN: `127.0.0.1:${controlPort}`,
        ANTNEST_ACP_OWNER_MEMBER_ID: memberId,
        ANTNEST_ACP_OWNER_LISTEN: `127.0.0.1:${ownerPort}`,
        ANTNEST_ACP_RUNTIME_CONTROLLER_URL: `http://127.0.0.1:${rcPort}/`,
        ANTNEST_ACP_OWNER_REGISTRATION_TIMEOUT: "30s",
        ANTNEST_ACP_SHUTDOWN_TIMEOUT: "3s",
        OTEL_SDK_DISABLED: "true",
        OTEL_TRACES_EXPORTER: "none",
        OTEL_METRICS_EXPORTER: "none",
      };
      delete childEnvironment.NODE_OPTIONS;
      await releaseReservations();
      const loader = createRequire(servicePackage).resolve("tsx");
      child = spawn(
        process.execPath,
        [
          "--import",
          loader,
          fileURLToPath(new URL("./src/main.ts", servicePackage)),
        ],
        {
          cwd: fileURLToPath(new URL(".", servicePackage)),
          env: childEnvironment,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      // Capture both events before the RC handshake and before sending a signal.
      child.once("exit", (code, signal) => {
        childExit = { code, signal };
        exited.resolve(childExit);
      });
      child.once("close", (code, signal) => {
        childClose = { code, signal };
        closed.resolve(childClose);
      });
      child.once("error", (error) => {
        failures.push(error);
        held.resolve({
          ok: false,
          error: new Error("ACP main process could not start"),
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-8192);
      });
      const startup = await bounded(
        Promise.race([
          held.promise,
          exited.promise.then((): Outcome<void> => ({
            ok: false,
            error: new Error("ACP main exited before its held registration"),
          })),
        ]),
        "real main registration and authenticated probe",
        8000,
      );
      if (!startup.ok) throw startup.error;
      expect(registrations).toBe(1);
      expect(receiptFinished).toBe(false);
      expect(handlersFinished).toBe(0);
      expect(sockets.size).toBe(1);
      await expectConnectionRefused(workspacePort);
      await expectConnectionRefused(controlPort);
      expect(childExit).toBeUndefined();
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      expect(child.kill("SIGTERM")).toBe(true);
      const actualExit = await bounded(
        exited.promise,
        "original main SIGTERM exit",
        4000,
      );
      const actualClose = await bounded(
        closed.promise,
        "original main process and stderr close",
      );
      await bounded(
        Promise.all([
          ...handlers,
          ...socketCloses,
          ...requestCloses,
          ...responseCloses,
        ]),
        "original RC registration handler and socket join",
      );
      expect(handlersFinished).toBe(1);
      expect(sockets.size).toBe(0);
      expect(registrations).toBe(1);
      expect(receiptFinished).toBe(false);
      await expectConnectionRefused(ownerPort);
      await expectConnectionRefused(workspacePort);
      await expectConnectionRefused(controlPort);
      // Check the exit only after all original resources have actually stopped.
      expect(actualExit).toEqual({ code: 0, signal: null });
      expect(actualClose).toEqual(actualExit);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const probe of probes) probe.abort();
      const serverClosing = closeListener(server);
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      const stopChild = async (): Promise<void> => {
        if (child === undefined) return;
        if (!childHasClosed()) {
          child.kill("SIGTERM");
          try {
            await bounded(
              closed.promise,
              "fixture child SIGTERM cleanup",
              2000,
            );
          } catch (error) {
            failures.push(error);
            if (!childHasClosed()) child.kill("SIGKILL");
          }
        }
        // SIGKILL is a fallback, not an exit receipt. Always wait for actual
        // close (including stderr), even after the cleanup guard has failed.
        await closed.promise;
      };
      const cleanup = await Promise.allSettled([
        stopChild(),
        serverClosing,
        releaseReservations(),
        ...handlers,
        ...socketCloses,
        ...requestCloses,
        ...responseCloses,
        ...probes.map(async (probe) => {
          await probe.join();
          await probe.result;
        }),
      ]);
      for (const result of cleanup)
        if (result.status === "rejected")
          failures.push(result.reason as unknown);
    }
    if (failures.length !== 0) {
      // Keep exceptional child stderr in the test failure for diagnosis without
      // exposing workload tokens, pending nonces or credential-bearing URLs.
      let diagnostic = stderr;
      for (const secret of sensitive)
        diagnostic = diagnostic.split(secret).join("[redacted]");
      diagnostic = diagnostic
        .replace(/Bearer\s+[A-Za-z0-9_-]+/giu, "Bearer [redacted]")
        .replace(/postgres(?:ql)?:\/\/[^\s"']+/gu, "[redacted database URL]");
      if (diagnostic.length !== 0)
        failures.push(new Error(`ACP main stderr (redacted):\n${diagnostic}`));
      throw new AggregateError(
        failures,
        "Real ACP main startup SIGTERM regression failed",
      );
    }
  }, 20_000);
});
