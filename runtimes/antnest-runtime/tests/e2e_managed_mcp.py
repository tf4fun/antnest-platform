"""Real PID 1 Runtime + official SDK stdio fixture; no database/Provider needed.

Build Runtime images first (README). This suite owns only its UUID-named
containers, network and temporary bind mounts and removes them on completion.
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
    return next(value for value in reversed(messages) if "result" in value or "error" in value)


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
            docker("rm", "-f", source, check=False)
        (cls.directory / "mcp-fixture").chmod(0o755)
        cls.egress = cls.prefix + "-probe"
        cls.addClassCleanup(lambda: docker("rm", "-f", cls.egress, check=False))
        fixture = Path(__file__).resolve().parent / "fixtures" / "egress_probe.py"
        docker("run", "-d", "--name", cls.egress, "--network", cls.network,
               "--mount", f"type=bind,src={fixture},dst=/probe.py,readonly",
               "--entrypoint", "python", cls.runtime_image, "/probe.py")
        inspection = json.loads(docker("inspect", cls.egress))[0]
        cls.egress_ip = inspection["NetworkSettings"]["Networks"][cls.network]["IPAddress"]

    def setUp(self):
        self.name = self.prefix + "-" + uuid.uuid4().hex[:6]
        self.addCleanup(lambda: docker("rm", "-f", self.name, check=False))
        self.workspace = self.directory / self.name
        self.workspace.mkdir(mode=0o777)
        self.workspace.chmod(0o777)
        self.requests = itertools.count(1)

    def start(self, servers=None):
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
                "-p", "127.0.0.1::8093", "-e", "OTEL_SDK_DISABLED=true", "-e", "ANTNEST_RUNTIME_SPEC=" + json.dumps(spec)]
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
        params["_meta"] = {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}}
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
        self.assertNotIn("error", result, result)
        return result["result"]

    def tool(self, name, arguments=None):
        return self.rpc("tools/call", {"name": name, "arguments": arguments or {}})

    def bash(self, command, timeout=3000):
        return self.tool("bash", {"command": command, "working_dir": {"root": "workspace", "path": "."}, "env": [], "timeout_ms": timeout})

    def test_background_process_and_managed_service_survive_other_calls(self):
        self.start()
        self.ready()
        tools = self.rpc("tools/list")["tools"]
        self.assertEqual(len(tools), 12)
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
                self.assertTrue(rpc_message(data)["result"]["isError"], data)
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
