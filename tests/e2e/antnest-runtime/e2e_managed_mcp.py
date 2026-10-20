"""Real PID 1 Runtime + official SDK stdio fixture; no database/Provider needed.

Build Runtime images first (README). This suite owns only its UUID-named
containers, anonymous volumes, network and temporary bind mounts and removes them on completion.
The UDP dependency is a readiness fixture, not an Egress integration test.
"""
import http.client
import hashlib
import datetime
import itertools
import json
import math
import os
import re
import socket
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request
import uuid


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=60, check=False)
    if check and result.returncode:
        raise RuntimeError(f"docker {args[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def eventually(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError("condition did not converge before the deadline")


def rpc_message(data):
    if data.startswith("{"):
        return json.loads(data)
    messages = [json.loads(line[5:].strip()) for line in data.splitlines() if line.startswith("data:")]
    return next((value for value in reversed(messages) if "result" in value or "error" in value), None)


class ManagedMcpE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prefix = os.environ.get("ANTNEST_RUNTIME_E2E_PREFIX", "antnest-mcp-e2e-" + uuid.uuid4().hex[:10])
        if re.fullmatch(r"antnest-mcp-e2e-[0-9a-f]{10}", cls.prefix) is None:
            raise ValueError("invalid isolated Runtime test prefix")
        cls.root = tempfile.TemporaryDirectory(prefix=cls.prefix + "-")
        cls.addClassCleanup(cls.root.cleanup)
        cls.directory = Path(cls.root.name)
        cls.directory.chmod(0o755)
        cls.runtime_image = os.environ.get("ANTNEST_RUNTIME_TEST_IMAGE", "antnest/antnest-runtime:managed-e2e")
        build_image = os.environ.get("ANTNEST_RUNTIME_BUILD_IMAGE", "antnest/antnest-runtime:managed-build")
        cls.network = cls.prefix + "-network"
        cls.addClassCleanup(lambda: docker("network", "rm", cls.network, check=False))
        docker("network", "create", cls.network)
        source = cls.prefix + "-fixture-source"
        try:
            docker("create", "--name", source, build_image, "/bin/true")
            docker("cp", source + ":/tmp/managed-mcp-fixture", str(cls.directory / "mcp-fixture"))
        finally:
            docker("rm", "-f", "--volumes", source, check=False)
        (cls.directory / "mcp-fixture").chmod(0o755)
        repository = Path(__file__).resolve().parents[3]
        cls.auth_directory = cls.directory / "auth"
        cls.authentication = json.loads(subprocess.check_output(
            ["node", str(repository / "tests/support/runtime-receiver-fixture.mjs"), str(cls.auth_directory)],
            text=True, timeout=30))
        cls.auth_volume = cls.prefix + "-auth"
        cls.addClassCleanup(lambda: docker("volume", "rm", cls.auth_volume, check=False))
        docker("volume", "create", cls.auth_volume)
        docker("run", "--rm", "--network", "none", "--entrypoint", "sh",
               "--mount", f"type=bind,src={cls.auth_directory},dst=/fixture/auth,readonly",
               "--mount", f"type=volume,src={cls.auth_volume},dst=/run/antnest-auth", cls.runtime_image,
               "-c", "chmod 700 /run/antnest-auth; cp /fixture/auth/callers.json /fixture/auth/tunnel.json /run/antnest-auth/; chown 0:0 /run/antnest-auth /run/antnest-auth/*; chmod 600 /run/antnest-auth/*")
        cls.mcp_authority = (cls.auth_directory / "mcp.headers").read_text().strip().split(": ", 1)[1]
        cls.status_authority = (cls.auth_directory / "status.headers").read_text().strip().split(": ", 1)[1]
        cls.probe_image = cls.prefix + ":readiness"
        cls.addClassCleanup(lambda: docker("image", "rm", cls.probe_image, check=False))
        docker("build", "-f", str(repository / "tests/support/runtime-tunnel/Dockerfile"),
               "-t", cls.probe_image, str(repository))
        cls.egress = cls.prefix + "-probe"
        cls.addClassCleanup(lambda: docker("rm", "-f", "--volumes", cls.egress, check=False))
        docker("run", "-d", "--name", cls.egress, "--network", cls.network,
               "--mount", f"type=bind,src={cls.auth_directory / 'egress-tunnel.json'},dst=/fixture/keys.json,readonly",
               cls.probe_image, "/fixture/keys.json")
        inspection = json.loads(docker("inspect", cls.egress))[0]
        cls.egress_ip = inspection["NetworkSettings"]["Networks"][cls.network]["IPAddress"]

    def setUp(self):
        self.name = self.prefix + "-" + uuid.uuid4().hex[:6]
        self.addCleanup(lambda: docker("rm", "-f", "--volumes", self.name, check=False))
        self.workspace = self.directory / self.name
        self.workspace.mkdir(mode=0o777)
        self.workspace.chmod(0o777)
        self.requests = itertools.count(1)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.listen_port = listener.getsockname()[1]

    def start(self, servers=None, telemetry=None):
        if servers is None:
            servers = [{"id": name, "command": "/opt/mcp-fixture", "env": {"FIXTURE_SECRET": "config-canary"}} for name in ["a", "b"]]
        spec = {
            "agent_id": self.name, "generation": 1, "listen": {"host": "0.0.0.0", "port": self.listen_port},
            "authentication": self.authentication,
            "network": {"packet_contract_revision": 2, "egress_endpoint": {"ipv4": self.egress_ip, "port": 8092}, "tunnel_ipv4": "100.64.0.2", "resolver_ipv4": "100.64.0.1"},
            "filesystem": {"workspace": "/workspace", "system_skills": "/skills"},
            "mcp_servers": servers,
        }
        args = ["run", "-d", "--name", self.name, "--network", self.network,
                "--cap-drop", "ALL", "--device", "/dev/net/tun", "--dns", "100.64.0.1", "--dns-option", "use-vc",
                "--tmpfs", "/run/antnest-mcp-home:rw,exec,nosuid,nodev,size=64m,mode=0711,uid=0,gid=0",
                "--mount", f"type=bind,src={self.workspace},dst=/workspace",
                "--mount", f"type=bind,src={self.directory / 'mcp-fixture'},dst=/opt/mcp-fixture,readonly",
                "--mount", f"type=volume,src={self.auth_volume},dst=/run/antnest-auth,readonly",
                "-e", "ANTNEST_SERVICE_AUTH_MODE=token", "-e", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true",
                "-e", "ANTNEST_SERVICE_AUTH_CALLERS_FILE=/run/antnest-auth/callers.json",
                "-p", f"127.0.0.1:{self.listen_port}:{self.listen_port}", "-e", "ANTNEST_RUNTIME_SPEC=" + json.dumps(spec)]
        for key, value in (telemetry or {"OTEL_SDK_DISABLED": "true"}).items():
            args.extend(["-e", f"{key}={value}"])
        for cap in ["CHOWN", "DAC_OVERRIDE", "KILL", "NET_ADMIN", "SETGID", "SETPCAP", "SETUID"]:
            args.extend(["--cap-add", cap])
        docker(*args, self.runtime_image)
        state = json.loads(docker("inspect", self.name))[0]
        bindings = state["NetworkSettings"]["Ports"].get(f"{self.listen_port}/tcp")
        # A fast, expected initialization failure may exit before inspection.
        self.port = int(bindings[0]["HostPort"]) if bindings else None

    def ready(self):
        def check():
            if self.port is None:
                return False
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{self.port}/status", headers={"Antnest-Service-Authorization": self.status_authority})
                with urllib.request.urlopen(request, timeout=1) as response:
                    status = json.load(response)
                self.execution_id = status["execution_id"]
                return status["status"] == "ready"
            except (OSError, urllib.error.URLError):
                return False
        try:
            eventually(check)
        except AssertionError:
            self.fail("Runtime failed to become ready: " + docker("logs", self.name))

    def request(self, method, params=None):
        params = dict(params or {})
        params.setdefault("_meta", {}).update({"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}})
        body = {"jsonrpc": "2.0", "id": next(self.requests), "method": method, "params": params}
        self.last_request_id = body["id"]
        headers = {"content-type": "application/json", "accept": "application/json, text/event-stream",
                   "Antnest-Service-Authorization": self.mcp_authority,
                   "mcp-protocol-version": "2026-07-28", "mcp-method": method,
                   "X-Antnest-Expected-Execution-ID": self.execution_id}
        if "name" in params:
            headers["mcp-name"] = params["name"]
        elif "uri" in params:
            headers["mcp-name"] = params["uri"]
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("POST", "/mcp", body=json.dumps(body), headers=headers)
        return connection

    def rpc(self, method, params=None):
        connection = self.request(method, params)
        try:
            response = connection.getresponse()
            data = response.read().decode()
            self.assertEqual(response.status, 200, data)
        finally:
            connection.close()
        result = rpc_message(data)
        self.assertIsNotNone(result, "MCP response ended without a terminal result")
        self.assertNotIn("error", result, result)
        return result["result"]

    def tool(self, name, arguments=None):
        return self.rpc("tools/call", {"name": name, "arguments": arguments or {}})

    def bash(self, command, timeout=3000):
        return self.tool("bash", {"command": command, "working_dir": ".", "env": [], "timeout_ms": timeout})

    def test_official_js_client_close_keeps_success_and_failure_trace_evidence(self):
        collector = self.name + "-jaeger"
        self.addCleanup(lambda: docker("rm", "-f", "--volumes", collector, check=False))
        docker("run", "-d", "--name", collector, "--network", self.network,
               "-p", "127.0.0.1::16686", "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0")
        inspection = json.loads(docker("inspect", collector))[0]
        address = inspection["NetworkSettings"]["Networks"][self.network]["IPAddress"]
        port = inspection["NetworkSettings"]["Ports"]["16686/tcp"][0]["HostPort"]
        self.start(telemetry={"OTEL_TRACES_EXPORTER": "otlp", "OTEL_METRICS_EXPORTER": "none",
                              "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://{address}:4318"})
        self.ready()
        (self.workspace / "read-me.txt").write_text("runtime close regression")
        success_trace, failure_trace = uuid.uuid4().hex, uuid.uuid4().hex
        fixture = Path(__file__).resolve().parent / "fixtures" / "http_close_client.mjs"
        subprocess.run(["node", str(fixture), f"http://127.0.0.1:{self.port}/mcp",
                        self.execution_id, success_trace, failure_trace, str(self.auth_directory / "mcp.headers")], check=True, timeout=30)
        # Flush the real Runtime exporter; no shared development services are changed.
        docker("stop", "--time", "15", self.name)
        self.assertEqual(json.loads(docker("inspect", self.name))[0]["State"]["ExitCode"], 0)

        def trace(trace_id):
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/traces/{trace_id}", timeout=2) as response:
                return json.load(response)["data"][0]["spans"]

        collected = {}

        def exported():
            try:
                collected["success"] = trace(success_trace)
                collected["failure"] = trace(failure_trace)
                return True
            except (OSError, KeyError, IndexError):
                return False

        eventually(exported)
        for span in collected["success"]:
            tags = {tag["key"]: tag["value"] for tag in span["tags"]}
            self.assertFalse(tags.get("error", False), span["operationName"])
            self.assertNotEqual(tags.get("otel.status_code"), "ERROR")
            self.assertFalse(any(field["value"] == "antnest.error" for log in span["logs"] for field in log["fields"]))
            if span["operationName"] == "HTTP POST /mcp":
                self.assertEqual(tags["antnest.protocol.outcome"], "success")
                self.assertIn(tags["http.transport.outcome"], ["success", "canceled"])
                if tags["http.transport.outcome"] == "canceled":
                    self.assertEqual(tags["http.transport.error.type"], "client_disconnected")
                    self.assertTrue(any(field["value"] == "antnest.cancelled" for log in span["logs"] for field in log["fields"]))
        operations = [span for span in collected["success"] if span["operationName"] == "runtime.mcp.operation"]
        self.assertGreaterEqual(len(operations), 9)  # Three connect/list/read/close cycles.
        failed = [span for span in collected["failure"] if span["operationName"] in ["runtime.mcp.operation", "HTTP POST /mcp"]
                  and any(tag["key"] == "error" and tag["value"] is True for tag in span["tags"])]
        self.assertEqual({span["operationName"] for span in failed}, {"runtime.mcp.operation", "HTTP POST /mcp"})
        print(json.dumps({"http_close_trace": "passed", "success_trace": success_trace,
                          "failure_trace": failure_trace, "successful_operations": len(operations),
                          "successful_disconnects": sum(any(tag["key"] == "http.transport.outcome" and tag["value"] == "canceled"
                                                             for tag in span["tags"]) for span in collected["success"]),
                          "failed_operation_and_http_spans": len(failed)}))

    def test_managed_stdio_completion_diagnostics_remain_inside_actual_span(self):
        repository = Path(__file__).resolve().parents[3]
        evidence = Path(os.environ.get("ANTNEST_RUNTIME_OBSERVABILITY_EVIDENCE",
                                       repository / "artifacts/verification/runtime-managed-completion")).resolve() / self.name
        self.assertTrue(evidence.is_relative_to((repository / "artifacts/verification").resolve()),
                        "Runtime evidence must stay inside repository artifacts/verification")
        evidence.mkdir(mode=0o700, parents=True)
        for directory in [evidence, *evidence.parents]:
            directory.chmod(0o700)
            if directory.name == "artifacts":
                break
        saved = []
        receipts = []
        connections, responses = [], []
        archived_phases = set()
        collector = self.name + "-jaeger"
        port = None

        def save(name, raw):
            raw = raw.encode() if isinstance(raw, str) else raw
            with os.fdopen(os.open(evidence / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
                output.write(raw)
            saved.append({"name": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})

        def snapshot():
            # Called before unittest removes the Runtime; failed/partial runs
            # retain diagnostics too. Never archive credentials from Config.Env.
            errors = []
            for name, args in [
                    ("runtime.log", ["logs", self.name]),
                    ("runtime-state.json", ["inspect", "--format", "{{json .State}}", self.name]),
                    ("runtime-image.json", ["inspect", "--format", "{{json .Image}}", self.name]),
                    ("runtime-container.json", ["inspect", "--format", "{{json .Id}}", self.name]),
                    ("collector.log", ["logs", collector]),
                    ("collector-state.json", ["inspect", "--format", "{{json .State}}", collector]),
                    ("collector-image.json", ["inspect", "--format", "{{json .Image}}", collector])]:
                try:
                    result = subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                            timeout=30, check=False)
                    save(name, result.stdout)
                    if result.returncode:
                        errors.append({"source": name, "exit_code": result.returncode})
                except (OSError, subprocess.TimeoutExpired) as error:
                    errors.append({"source": name, "error": type(error).__name__})
            save("requests-final.json", json.dumps({"agent_id": self.name, "execution_id": getattr(self, "execution_id", None),
                                                     "requests": receipts}, sort_keys=True, indent=2))
            save("snapshot-errors.json", json.dumps(errors, sort_keys=True, indent=2))
            save("files.json", json.dumps(saved, sort_keys=True, indent=2))
            self.assertEqual(errors, [], "Runtime evidence snapshot failed")

        def collect_query(receipt, suffix):
            def fetch_json(path, name):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}" + path, timeout=2) as result:
                        raw = result.read()
                except urllib.error.HTTPError as error:
                    with error:
                        save(name + "-http-error.body", error.read())
                    save(name + "-http-error.json", json.dumps({"status": error.code}))
                    raise
                save(name + ".json", raw)
                return json.loads(raw)

            # Jaeger 2.21 removed /api/traces search. As in the shared
            # jaeger-search.mjs contract, use v3 search and original v1 details.
            now = datetime.datetime.now(datetime.timezone.utc)
            query = urllib.parse.urlencode({
                "query.serviceName": "antnest-runtime", "query.searchDepth": "100",
                "query.startTimeMin": (now - datetime.timedelta(hours=1)).isoformat(),
                "query.startTimeMax": now.isoformat(),
                "query.attributes": json.dumps({"antnest.agent.id": self.name,
                                                "antnest.request.id": str(receipt["request_id"])})})
            name = f"{receipt['phase']}-{suffix}"
            found = fetch_json("/api/v3/trace-summaries?" + query, name + "-search")
            self.assertIsInstance(found, dict)
            self.assertTrue(set(found) <= {"summaries", "nextPageToken"})
            self.assertFalse(found.get("nextPageToken"), "unread trace search page")
            summaries = found.get("summaries", [])
            self.assertIsInstance(summaries, list)
            ids = [summary["traceId"] for summary in summaries]
            self.assertEqual(len(ids), len(set(ids)), "duplicate actual trace search ID")
            traces = []
            for trace_id in ids:
                self.assertRegex(trace_id, r"^[0-9a-f]{32}$")
                detail = fetch_json("/api/traces/" + trace_id, name + "-" + trace_id)
                self.assertFalse(detail.get("errors"), "trace detail query failed")
                self.assertEqual(len(detail["data"]), 1)
                self.assertEqual(detail["data"][0]["traceID"], trace_id)
                traces.extend(detail["data"])
            return traces

        def preserve_failed_run():
            errors = []
            for index, resource in enumerate([*responses, *connections]):
                try:
                    resource.close()
                except Exception as error:
                    errors.append({"stage": "close", "index": index, "error": type(error).__name__})
            try:
                state = docker("inspect", "--format", "{{json .State}}", self.name, check=False)
                if state and json.loads(state)["Running"]:
                    docker("stop", "--time", "15", self.name)
            except Exception as error:
                errors.append({"stage": "stop", "error": type(error).__name__})
            for receipt in receipts:
                if receipt["phase"] in archived_phases:
                    continue
                complete = False
                deadline = time.monotonic() + 10
                attempt = 0
                while port is not None and time.monotonic() < deadline:
                    attempt += 1
                    try:
                        traces = collect_query(receipt, f"failure-query-{attempt}")
                        if traces and any(span["operationName"] == "runtime.mcp.stdio"
                                          for trace in traces for span in trace["spans"]):
                            complete = True
                            break
                    except Exception as error:
                        save(f"{receipt['phase']}-failure-query-{attempt}-error.json",
                             json.dumps({"error": type(error).__name__}))
                    time.sleep(0.1)
                if not complete:
                    errors.append({"stage": "trace", "phase": receipt["phase"], "error": "incomplete"})
            save("failure-evidence-errors.json", json.dumps(errors, sort_keys=True, indent=2))
            self.assertEqual(errors, [], "failed-run evidence preservation incomplete")

        # unittest cleanups run in reverse: join/flush and raw first, then
        # snapshots, then Collector removal, then the base Runtime removal.
        self.addCleanup(lambda: docker("rm", "-f", "--volumes", collector))
        self.addCleanup(snapshot)
        self.addCleanup(preserve_failed_run)
        docker("run", "-d", "--name", collector, "--network", self.network,
               "-p", "127.0.0.1::16686", "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0")
        inspection = json.loads(docker("inspect", collector))[0]
        address = inspection["NetworkSettings"]["Networks"][self.network]["IPAddress"]
        port = inspection["NetworkSettings"]["Ports"]["16686/tcp"][0]["HostPort"]
        self.start(telemetry={"OTEL_TRACES_EXPORTER": "otlp", "OTEL_METRICS_EXPORTER": "none",
                              "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://{address}:4318"})
        self.ready()
        for phase, tool, arguments in [
                ("success", "mcp__a__echo", {"value": "managed-completion-canary"}),
                ("failure", "mcp__a__fail", {})]:
            connection = self.request("tools/call", {"name": tool, "arguments": arguments})
            connections.append(connection)
            receipts.append({"phase": phase, "tool": tool, "request_id": self.last_request_id})
            try:
                response = connection.getresponse()
                responses.append(response)
                self.assertEqual(response.status, 200)
                raw = response.read()
                save(phase + "-response.body", raw)
                envelope = rpc_message(raw.decode())
                self.assertEqual(envelope["id"], self.last_request_id)
                self.assertNotIn("error", envelope)
                result = envelope["result"]
            finally:
                connection.close()
            self.assertEqual(result.get("isError", False), phase == "failure")
        connection = self.request("tools/call", {"name": "mcp__a__progress",
                                  "arguments": {"gate": "completion-cancel"},
                                  "_meta": {"progressToken": "completion-cancel"}})
        connections.append(connection)
        receipts.append({"phase": "cancel", "tool": "mcp__a__progress", "request_id": self.last_request_id})
        save("requests.json", json.dumps({"agent_id": self.name, "execution_id": self.execution_id,
                                          "requests": receipts}, sort_keys=True, indent=2))
        response = None
        try:
            response = connection.getresponse()
            responses.append(response)
            self.assertEqual(response.status, 200)
            preview = bytearray()
            while True:
                line = response.readline()
                preview.extend(line)
                self.assertTrue(line, "managed call ended before live progress")
                if line.startswith(b"data:"):
                    frame = json.loads(line[5:])
                    self.assertNotIn("result", frame)
                    if frame.get("method") == "notifications/progress":
                        self.assertEqual(frame["params"]["progressToken"], "completion-cancel")
                        save("cancel-first-progress.body", preview)
                        break
        finally:
            if response is not None:
                response.close()
            connection.close()
        eventually(lambda: (self.workspace / "completion-cancel-canceled").exists())
        eventually(lambda: (self.workspace / "cancel-received").exists())
        markers = {}
        for name in ["completion-cancel-started", "cancel-received"]:
            raw = docker("exec", "--user", "0", self.name, "cat", "/workspace/" + name)
            save(name + ".json", raw)
            markers[name] = json.loads(raw)
        self.assertEqual(markers["completion-cancel-started"], markers["cancel-received"])
        docker("stop", "--time", "15", self.name)
        self.assertEqual(json.loads(docker("inspect", self.name))[0]["State"]["ExitCode"], 0)

        def fields(items):
            result = {item["key"]: item["value"] for item in items}
            self.assertEqual(len(result), len(items), "duplicate original attribute")
            return result

        summary = []
        for receipt in receipts:
            collected = []
            attempt = 0

            def exported():
                nonlocal attempt
                attempt += 1
                try:
                    traces = collect_query(receipt, f"query-{attempt}")
                    if not traces:
                        return False
                    self.assertEqual(len(traces), 1, "ambiguous actual request trace")
                    if len(traces[0]["spans"]) < 4:
                        return False
                    collected[:] = traces
                    archived_phases.add(receipt["phase"])
                    return True
                except (OSError, urllib.error.URLError):
                    return False

            eventually(exported)
            trace = collected[0]
            self.assertEqual(len(trace["spans"]), 4)
            self.assertEqual(len({span["spanID"] for span in trace["spans"]}), 4)
            self.assertEqual({span["traceID"] for span in trace["spans"]}, {trace["traceID"]})
            for span in trace["spans"]:
                self.assertTrue(all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                                    for value in [span["startTime"], span["duration"], span["startTime"] + span["duration"]]))
                self.assertGreaterEqual(span["startTime"], 0)
                self.assertGreaterEqual(span["duration"], 0)
            by_name = {span["operationName"]: span for span in trace["spans"]}
            self.assertEqual(set(by_name), {"HTTP POST /mcp", "runtime.mcp.operation", "runtime.mcp.tool", "runtime.mcp.stdio"})
            server, operation, tool, stdio = (by_name[name] for name in [
                "HTTP POST /mcp", "runtime.mcp.operation", "runtime.mcp.tool", "runtime.mcp.stdio"])
            self.assertFalse([ref for ref in server["references"] if ref["refType"] == "CHILD_OF"])
            for child, parent in [(operation, server), (tool, operation), (stdio, tool)]:
                self.assertEqual(child["processID"], parent["processID"])
                refs = [ref for ref in child["references"] if ref["refType"] == "CHILD_OF"]
                self.assertEqual([(ref["traceID"], ref["spanID"]) for ref in refs], [(trace["traceID"], parent["spanID"])])
            self.assertEqual(trace["processes"][stdio["processID"]]["serviceName"], "antnest-runtime")
            resource = fields(trace["processes"][stdio["processID"]]["tags"])
            self.assertEqual(resource["antnest.agent.id"], self.name)
            self.assertEqual(str(resource["antnest.runtime.generation"]), "1")
            attrs = fields(operation["tags"])
            self.assertEqual(attrs["antnest.agent.id"], self.name)
            self.assertEqual(attrs["antnest.runtime.execution.id"], self.execution_id)
            self.assertEqual(attrs["antnest.request.id"], str(receipt["request_id"]))
            self.assertEqual(attrs["mcp.tool.name"], receipt["tool"])
            attrs = fields(stdio["tags"])
            failed = receipt["phase"] != "success"
            self.assertEqual(attrs["span.kind"], "client")
            self.assertEqual(attrs["mcp.tool.name"], receipt["tool"])
            self.assertEqual(attrs["antnest.protocol.outcome"], "error" if failed else "success")
            self.assertEqual(attrs["otel.status_code"], "ERROR" if failed else "OK")
            self.assertEqual(attrs.get("error", False), failed)
            self.assertEqual(len(stdio["logs"]), int(failed))
            if failed:
                code = "outcome_unknown" if receipt["phase"] == "cancel" else "managed_tool_error"
                self.assertEqual(attrs["error.type"], code)
                event = stdio["logs"][0]
                diagnostic = fields(event["fields"])
                expected = {"event": "antnest.error", "antnest.error.stage": "mcp.stdio",
                            "antnest.error.type": code, "antnest.error.code": code,
                            "antnest.error.message": "Execution ended without a confirmed effect outcome"
                            if receipt["phase"] == "cancel" else "Managed tool returned isError"}
                if receipt["phase"] == "cancel":
                    causes = diagnostic["antnest.error.cause_types"]
                    diagnostic["antnest.error.cause_types"] = json.loads(causes) if isinstance(causes, str) else causes
                    expected["antnest.error.cause_types"] = ["canceled"]
                self.assertEqual(diagnostic, expected)
                self.assertTrue(isinstance(event["timestamp"], (int, float)) and math.isfinite(event["timestamp"]))
                self.assertLessEqual(stdio["startTime"], event["timestamp"])
                # Jaeger separately truncates start and duration to microseconds.
                # Raw SDK nanosecond containment is checked by managed_bridge.rs.
                self.assertLessEqual(event["timestamp"], stdio["startTime"] + stdio["duration"] + 1)
            else:
                self.assertEqual(attrs.get("error.type", ""), "")
            self.assertNotIn("managed-completion-canary", json.dumps(trace))
            self.assertNotIn("progress-payload-canary", json.dumps(trace))
            summary.append({**receipt, "trace_id": trace["traceID"], "stdio_span_id": stdio["spanID"],
                            "spans": len(trace["spans"]), "raw_warnings_retained": True})
        save("result.json", json.dumps({"status": "passed", "requests": summary}, sort_keys=True, indent=2))
        print(json.dumps({"managed_stdio_completion": "passed", "evidence": str(evidence), "requests": summary}))

    def test_managed_stdio_failure_preserves_traces_before_removing_collector(self):
        original = self.request
        calls = 0

        def interrupted_request(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise RuntimeError("controlled managed evidence interruption")
            return original(*args, **kwargs)

        with mock.patch.object(self, "request", interrupted_request):
            with self.assertRaisesRegex(RuntimeError, "^controlled managed evidence interruption$"):
                self.test_managed_stdio_completion_diagnostics_remain_inside_actual_span()
        self.assertTrue(self.doCleanups(), "failure finalizer must finish all resource cleanup")
        repository = Path(__file__).resolve().parents[3]
        evidence = Path(os.environ.get("ANTNEST_RUNTIME_OBSERVABILITY_EVIDENCE",
                                       repository / "artifacts/verification/runtime-managed-completion")) / self.name
        self.assertEqual(json.loads((evidence / "failure-evidence-errors.json").read_text()), [])
        self.assertEqual(json.loads((evidence / "snapshot-errors.json").read_text()), [])
        receipts = json.loads((evidence / "requests-final.json").read_text())["requests"]
        self.assertEqual([receipt["phase"] for receipt in receipts], ["success", "failure"])
        for receipt in receipts:
            raws = list(evidence.glob(receipt["phase"] + "-failure-query-*.json"))
            self.assertTrue(raws, "failed run must retain original query bytes")
            self.assertTrue(any(any(span["operationName"] == "runtime.mcp.stdio"
                                    for trace in json.loads(path.read_text()).get("data", []) for span in trace["spans"])
                                for path in raws))
        for item in json.loads((evidence / "files.json").read_text()):
            path = evidence / item["name"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"])
            self.assertEqual(path.stat().st_size, item["bytes"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(evidence.stat().st_mode & 0o777, 0o700)

    def test_background_process_and_managed_service_survive_other_calls(self):
        self.start()
        self.ready()
        tools = self.rpc("tools/list")["tools"]
        self.assertEqual(len(tools), 16)
        first = self.tool("mcp__a__echo", {"value": "one"})["structuredContent"]
        second = self.tool("mcp__a__echo", {"value": "two"})["structuredContent"]
        other = self.tool("mcp__b__echo", {"value": "other"})["structuredContent"]
        self.assertEqual((first["uid"], first["gid"], first["home"]), (2000, 1000, "/run/antnest-mcp-home/2000"))
        self.assertTrue(first["explicit_env"])
        self.assertFalse(first["supervisor_env"] or first["launcher_env"])
        self.assertEqual(first["pid"], second["pid"])
        self.assertNotEqual(first["pid"], other["pid"])
        self.assertEqual(second["calls"], 2)
        self.assertTrue(self.tool("mcp__a__fail")["isError"])
        started = self.bash("python -m http.server 18080 --bind 127.0.0.1 >background.log 2>&1 </dev/null & echo $! > background.pid; printf started")
        self.assertFalse(started.get("isError", False), started)
        self.tool("write", {"path": "AGENTS.md", "content": "Use the persistent workspace."})
        info = self.rpc("resources/read", {"uri": "antnest://runtime/info"})
        content = json.loads(info["contents"][0]["text"])
        self.assertEqual(content["instructions"]["content"], "Use the persistent workspace.")
        self.assertNotIn("mcp_servers", content)
        fetched = self.bash("curl --retry 3 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:18080/AGENTS.md", timeout=5000)
        self.assertEqual(fetched["structuredContent"]["stdout"], "Use the persistent workspace.", fetched)
        waiting = self.request("tools/call", {"name": "mcp__a__wait", "arguments": {}})
        try:
            eventually(lambda: (self.workspace / "wait-started").exists())
        finally:
            waiting.close()
        eventually(lambda: (self.workspace / "wait-canceled").exists())
        self.assertEqual(self.tool("mcp__a__echo", {"value": "after-cancel"})["structuredContent"]["pid"], first["pid"])
        self.assertEqual(self.bash("curl -fsS http://127.0.0.1:18080/AGENTS.md")["structuredContent"]["exit_code"], 0)
        timed_out = self.bash("sleep 60", timeout=100)
        self.assertTrue(timed_out["isError"])
        self.assertEqual(self.bash("kill -0 $(cat background.pid)")["structuredContent"]["exit_code"], 0)
        inherited = self.bash("sleep 60 & echo $! > inherited.pid; printf inherited", timeout=3000)
        self.assertEqual(inherited["structuredContent"]["stdout"], "inherited")
        self.assertTrue(inherited["structuredContent"]["truncated"])
        self.assertEqual(self.bash("kill $(cat background.pid) $(cat inherited.pid)")["structuredContent"]["exit_code"], 0)
        def reaped():
            return docker("exec", self.name, "python", "-c", "from pathlib import Path; print(all(not Path('/proc/'+Path(p).read_text().strip()).exists() for p in ['background.pid','inherited.pid']))") == "True"
        eventually(reaped)
        logs = docker("logs", self.name)
        self.assertNotIn("config-canary", logs)
        self.assertNotIn("fixture-stderr-canary", logs)
        docker("stop", "--time", "15", self.name)
        self.assertEqual(json.loads(docker("inspect", self.name))[0]["State"]["ExitCode"], 0)

    def test_empty_configuration_still_provides_information_and_four_tools(self):
        self.start([])
        self.ready()
        self.assertEqual(len(self.rpc("tools/list")["tools"]), 4)
        self.assertEqual(self.rpc("resources/list")["resources"][0]["uri"], "antnest://runtime/info")

    def progress_call(self, name, arguments, release, fail=False):
        token = "outer-" + uuid.uuid4().hex
        connection = self.request("tools/call", {"name": name, "arguments": arguments, "_meta": {"progressToken": token}})
        try:
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            events = []
            while True:
                line = response.readline()
                self.assertTrue(line, "completion arrived without live progress")
                if not line.startswith(b"data:"):
                    continue
                frame = json.loads(line[5:])
                events.append(frame)
                self.assertNotIn("result", frame, "tool completed before its first progress")
                if frame.get("method") == "notifications/progress":
                    break
            self.assertEqual(events[-1]["params"]["progressToken"], token)
            self.assertFalse(release.exists())
            release.write_text("finish")
            tail = response.read().decode()
            events.extend(json.loads(line[5:]) for line in tail.splitlines() if line.startswith("data:"))
            self.assertEqual(sum("result" in event for event in events), 1)
            self.assertIn("result", events[-1])
            updates = [event["params"] for event in events if event.get("method") == "notifications/progress"]
            self.assertTrue(all(update["progressToken"] == token for update in updates))
            self.assertTrue(all(a["progress"] < b["progress"] for a, b in zip(updates, updates[1:])))
            self.assertEqual(events[-1]["result"].get("isError", False), fail)
            return updates, events[-1]["result"]
        finally:
            release.touch()
            connection.close()

    def test_bash_progress_crosses_the_non_root_executor_and_http_before_completion(self):
        self.start([])
        self.ready()
        command = "printf bash-progress-canary; while [ ! -e bash-release ]; do sleep 0.05; done; printf tail; printf diagnostic >&2"
        updates, result = self.progress_call("bash", {"command": command, "working_dir": ".", "env": [], "timeout_ms": 5000}, self.workspace / "bash-release")
        self.assertTrue(any("bash-progress-canary" in update.get("message", "") for update in updates))
        self.assertTrue(all("total" not in update for update in updates))
        self.assertEqual(result["structuredContent"]["stdout"], "bash-progress-canarytail")
        self.assertEqual(result["structuredContent"]["stderr"], "diagnostic")
        connection = self.request("tools/call", {"name": "bash", "arguments": {"command": "printf quiet", "working_dir": ".", "env": [], "timeout_ms": 1000}})
        try:
            body = connection.getresponse().read().decode()
            self.assertNotIn("notifications/progress", body)
            self.assertEqual(rpc_message(body)["result"]["structuredContent"]["stdout"], "quiet")
        finally:
            connection.close()
        self.assertNotIn("bash-progress-canary", docker("logs", self.name))

    def test_managed_progress_preserves_values_and_stops_on_failure_or_cancel(self):
        self.start()
        self.ready()
        updates, _ = self.progress_call("mcp__a__progress", {"fail": True, "gate": "progress-error"}, self.workspace / "progress-error-release", fail=True)
        self.assertEqual([(update["progress"], update["total"]) for update in updates], [(0.5, 2.0), (2.0, 2.0)])
        self.assertNotIn("progress-payload-canary", docker("logs", self.name))
        # Each invocation owns its markers; no cross-host unlink/recreate race.
        connection = self.request("tools/call", {"name": "mcp__a__progress", "arguments": {"gate": "progress-cancel"}, "_meta": {"progressToken": "cancel-preview"}})
        response = None
        try:
            response = connection.getresponse()
            while True:
                line = response.readline()
                self.assertTrue(line, "progress stream ended before cancellation")
                if b"notifications/progress" in line:
                    break
        finally:
            if response is not None:
                response.close()
            connection.close()
        eventually(lambda: (self.workspace / "progress-cancel-canceled").exists())
        eventually(lambda: (self.workspace / "cancel-received").exists())
        # MCP output defaults to 0600 under its separate UID. Read the two
        # synthetic fixture markers as the trusted test supervisor on Linux.
        marker = lambda name: json.loads(docker("exec", "--user", "0", self.name, "cat", "/workspace/" + name))
        self.assertEqual(marker("cancel-received"), marker("progress-cancel-started"))
        self.assertFalse(self.tool("mcp__a__echo", {"value": "after-progress-cancel"}).get("isError", False))

    def assert_failed_start(self, config, seconds=10):
        self.start(config)
        eventually(lambda: json.loads(docker("inspect", self.name))[0]["State"]["Running"] is False, seconds)
        state = json.loads(docker("inspect", self.name))[0]["State"]
        self.assertNotEqual(state["ExitCode"], 0)
        logs = docker("logs", self.name)
        self.assertIn("managed_mcp_start_failed", logs)
        self.assertNotIn("Runtime is ready", logs)

    def test_missing_executable_prevents_readiness(self):
        self.assert_failed_start([{"id": "bad", "command": "/missing-program"}])

    def test_network_forwarding_is_available_during_mcp_initialization(self):
        self.start([{"id": "network", "command": "/opt/mcp-fixture", "args": ["requires-network"]}])
        self.ready()
        self.assertEqual(self.tool("mcp__network__echo", {"value": "ready"})["structuredContent"]["value"], "ready")

    def test_duplicate_catalog_prevents_readiness(self):
        self.assert_failed_start([{"id": "bad", "command": "/opt/mcp-fixture", "args": ["duplicate"]}])

    def test_initialization_is_bounded(self):
        self.assert_failed_start([{"id": "slow", "command": "/opt/mcp-fixture", "args": ["no-init"]}], 38)

    def test_required_process_exit_stops_runtime(self):
        self.start()
        self.ready()
        connection = self.request("tools/call", {"name": "mcp__a__crash", "arguments": {}})
        try:
            response = connection.getresponse()
            data = response.read().decode()
            # Fatal child exit races response delivery with Supervisor shutdown.
            if response.status == 200:
                # SSE headers may already be sent when the fatal shutdown
                # closes the body. Exit code and fault log below remain mandatory.
                terminal = rpc_message(data)
                if terminal is not None:
                    self.assertTrue(terminal["result"]["isError"], data)
            else:
                self.assertIn(response.status, [500, 503], data)
        except (OSError, http.client.HTTPException):
            pass
        finally:
            connection.close()
        eventually(lambda: json.loads(docker("inspect", self.name))[0]["State"]["Running"] is False)
        self.assertNotEqual(json.loads(docker("inspect", self.name))[0]["State"]["ExitCode"], 0)
        self.assertIn("managed_mcp_service_failed", docker("logs", self.name))


if __name__ == "__main__":
    unittest.main(verbosity=2)
