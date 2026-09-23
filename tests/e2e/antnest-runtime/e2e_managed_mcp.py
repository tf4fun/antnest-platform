"""Real PID 1 Runtime + official SDK stdio fixture; no database/Provider needed.

Build Runtime images first (README). This suite owns only its UUID-named
containers, anonymous volumes, network and temporary bind mounts and removes them on completion.
The UDP dependency is a readiness fixture, not an Egress integration test.
"""
import http.client
import itertools
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import urllib.error
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
        cls.prefix = "antnest-mcp-e2e-" + uuid.uuid4().hex[:10]
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
        cls.egress = cls.prefix + "-probe"
        cls.addClassCleanup(lambda: docker("rm", "-f", "--volumes", cls.egress, check=False))
        fixture = Path(__file__).resolve().parent / "fixtures" / "egress_probe.py"
        docker("run", "-d", "--name", cls.egress, "--network", cls.network,
               "--mount", f"type=bind,src={fixture},dst=/probe.py,readonly",
               "--entrypoint", "python", cls.runtime_image, "/probe.py")
        inspection = json.loads(docker("inspect", cls.egress))[0]
        cls.egress_ip = inspection["NetworkSettings"]["Networks"][cls.network]["IPAddress"]

    def setUp(self):
        self.name = self.prefix + "-" + uuid.uuid4().hex[:6]
        self.addCleanup(lambda: docker("rm", "-f", "--volumes", self.name, check=False))
        self.workspace = self.directory / self.name
        self.workspace.mkdir(mode=0o777)
        self.workspace.chmod(0o777)
        self.requests = itertools.count(1)

    def start(self, servers=None, telemetry=None):
        if servers is None:
            servers = [{"id": name, "command": "/opt/mcp-fixture", "env": {"FIXTURE_SECRET": "config-canary"}} for name in ["a", "b"]]
        spec = {
            "agent_id": self.name, "generation": 1, "listen": {"host": "0.0.0.0", "port": 8093},
            "network": {"packet_contract_revision": 1, "egress_endpoint": {"ipv4": self.egress_ip, "port": 8092}, "tunnel_ipv4": "100.64.0.2", "resolver_ipv4": "100.64.0.1"},
            "filesystem": {"workspace": "/workspace", "system_skills": "/skills"},
            "mcp_servers": servers,
        }
        args = ["run", "-d", "--name", self.name, "--network", self.network,
                "--cap-drop", "ALL", "--device", "/dev/net/tun", "--dns", "100.64.0.1", "--dns-option", "use-vc",
                "--mount", f"type=bind,src={self.workspace},dst=/workspace",
                "--mount", f"type=bind,src={self.directory / 'mcp-fixture'},dst=/opt/mcp-fixture,readonly",
                "-p", "127.0.0.1::8093", "-e", "ANTNEST_RUNTIME_SPEC=" + json.dumps(spec)]
        for key, value in (telemetry or {"OTEL_SDK_DISABLED": "true"}).items():
            args.extend(["-e", f"{key}={value}"])
        for cap in ["CHOWN", "DAC_OVERRIDE", "KILL", "NET_ADMIN", "SETGID", "SETPCAP", "SETUID"]:
            args.extend(["--cap-add", cap])
        docker(*args, self.runtime_image)
        state = json.loads(docker("inspect", self.name))[0]
        bindings = state["NetworkSettings"]["Ports"].get("8093/tcp")
        # A fast, expected initialization failure may exit before inspection.
        self.port = int(bindings[0]["HostPort"]) if bindings else None

    def ready(self):
        def check():
            if self.port is None:
                return False
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/status", timeout=1) as response:
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
        headers = {"content-type": "application/json", "accept": "application/json, text/event-stream",
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
        return self.tool("bash", {"command": command, "working_dir": {"root": "workspace", "path": "."}, "env": [], "timeout_ms": timeout})

    def test_official_js_client_close_keeps_success_and_failure_trace_evidence(self):
        collector = self.name + "-jaeger"
        self.addCleanup(lambda: docker("rm", "-f", "--volumes", collector, check=False))
        docker("run", "-d", "--name", collector, "--network", self.network,
               "-p", "127.0.0.1::16686", "cr.jaegertracing.io/jaegertracing/jaeger:2.20.0")
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
                        self.execution_id, success_trace, failure_trace], check=True, timeout=30)
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

    def test_background_process_and_managed_service_survive_other_calls(self):
        self.start()
        self.ready()
        tools = self.rpc("tools/list")["tools"]
        self.assertEqual(len(tools), 14)
        first = self.tool("mcp__a__echo", {"value": "one"})["structuredContent"]
        second = self.tool("mcp__a__echo", {"value": "two"})["structuredContent"]
        other = self.tool("mcp__b__echo", {"value": "other"})["structuredContent"]
        self.assertEqual((first["uid"], first["gid"], first["home"]), (1000, 1000, "/workspace"))
        self.assertTrue(first["explicit_env"])
        self.assertFalse(first["supervisor_env"] or first["launcher_env"])
        self.assertEqual(first["pid"], second["pid"])
        self.assertNotEqual(first["pid"], other["pid"])
        self.assertEqual(second["calls"], 2)
        self.assertTrue(self.tool("mcp__a__fail")["isError"])
        started = self.bash("python -m http.server 18080 --bind 127.0.0.1 >background.log 2>&1 </dev/null & echo $! > background.pid; printf started")
        self.assertFalse(started.get("isError", False), started)
        self.tool("write", {"path": {"root": "workspace", "path": "AGENTS.md"}, "content": "Use the persistent workspace."})
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
        updates, result = self.progress_call("bash", {"command": command, "working_dir": {"root": "workspace", "path": "."}, "env": [], "timeout_ms": 5000}, self.workspace / "bash-release")
        self.assertTrue(any("bash-progress-canary" in update.get("message", "") for update in updates))
        self.assertTrue(all("total" not in update for update in updates))
        self.assertEqual(result["structuredContent"]["stdout"], "bash-progress-canarytail")
        self.assertEqual(result["structuredContent"]["stderr"], "diagnostic")
        connection = self.request("tools/call", {"name": "bash", "arguments": {"command": "printf quiet", "working_dir": {"root": "workspace", "path": "."}, "env": [], "timeout_ms": 1000}})
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
        self.assertEqual(json.loads((self.workspace / "cancel-received").read_text()), json.loads((self.workspace / "progress-cancel-started").read_text()))
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
