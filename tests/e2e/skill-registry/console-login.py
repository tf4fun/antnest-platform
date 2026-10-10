"""Real Gateway login through Admin Console to Skill Registry.

Run against an isolated Compose project with postgres, Identity, and Registry up.
"""

import json
import io
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


PROJECT = os.environ.get("ANTNEST_E2E_COMPOSE_PROJECT", "antnest-skill-console-verify")
CONSOLE = f"{PROJECT}-console-login-e2e"
GATEWAY = f"{PROJECT}-gateway-login-e2e"
TOKEN = os.environ.get("ANTNEST_SKILL_REGISTRY_API_TOKEN", "antnest-skill-registry-local-development-token")
EVIDENCE = Path(__file__).resolve().parents[3] / "artifacts/verification/skill-registry-console-login-e2e.json"


def docker(*args):
    return subprocess.check_output(("docker", *args), text=True).strip()


def request(base, path, method="GET", headers=None, payload=None, data=None):
    if payload is not None:
        data = json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers or {})
    try:
        response = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        return response.status, response.headers, json.loads(body) if body else None


def main():
    started = []
    try:
        docker("run", "-d", "--name", CONSOLE, "--network", f"{PROJECT}_development",
               "--network-alias", "admin-console",
               "-e", "ANTNEST_IDENTITY_SERVICE_URL=http://identity-service:8080",
               "-e", "ANTNEST_AGENT_CONTROLLER_URL=http://agent-controller:8080",
               "-e", "ANTNEST_AGENT_ACP_SERVICE_URL=http://agent-acp-service:8080",
               "-e", "ANTNEST_SKILL_REGISTRY_URL=http://skill-registry:8080",
               "-e", f"ANTNEST_SKILL_REGISTRY_API_TOKEN={TOKEN}", "antnest/admin-console:local")
        started.append(CONSOLE)
        docker("run", "-d", "--name", GATEWAY, "--network", f"{PROJECT}_development",
               "-p", "127.0.0.1::8080",
               "-e", "ANTNEST_IDENTITY_SERVICE_URL=http://identity-service:8080",
               "-e", "ANTNEST_ADMIN_CONSOLE_URL=http://admin-console:8080",
               "-e", "ANTNEST_AGENT_UI_URL=http://agent-ui:8080",
               "-e", "ANTNEST_AGENT_CONTROLLER_URL=http://agent-controller:8080",
               "-e", "ANTNEST_AGENT_ACP_URL=http://agent-acp-service:8080",
               "-e", "ANTNEST_EDGE_PUBLIC_ORIGIN=http://127.0.0.1",
               "-e", "ANTNEST_EDGE_COOKIE_SECURE=true", "antnest/edge-gateway:local")
        started.append(GATEWAY)
        base = "http://" + docker("port", GATEWAY, "8080/tcp").splitlines()[0]
        for _ in range(40):
            try:
                if request(base, "/status")[0] == 200:
                    break
            except (OSError, urllib.error.URLError):
                time.sleep(0.25)
        else:
            raise AssertionError("Gateway did not become ready")
        assert request(base, "/api/admin/skills")[0] == 401

        identity = f"{PROJECT}-identity-service-1"
        entries = json.loads(docker("inspect", "--format", "{{json .Config.Env}}", identity))
        values = dict(entry.split("=", 1) for entry in entries)
        credentials = {
            "organization_slug": values["ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG"],
            "email": values["ANTNEST_BOOTSTRAP_ADMIN_EMAIL"],
            "password": values["ANTNEST_BOOTSTRAP_ADMIN_PASSWORD"],
        }
        status, headers, _ = request(base, "/api/session/login", "POST",
                                     {"Content-Type": "application/json", "Origin": "http://127.0.0.1"}, credentials)
        assert status == 200, f"login failed: {status}"
        cookies = dict(header.split(";", 1)[0].split("=", 1) for header in headers.get_all("Set-Cookie", []))
        assert cookies.get("antnest_session") and cookies.get("antnest_csrf")
        auth = {"Cookie": "; ".join(f"{key}={value}" for key, value in cookies.items()),
                "Origin": "http://127.0.0.1", "X-Antnest-CSRF-Token": cookies["antnest_csrf"]}
        status, _, page = request(base, "/api/admin/skills", headers=auth)
        assert status == 200 and isinstance(page["items"], list), f"authenticated list failed: {status}"

        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
            package.writestr("SKILL.md", "---\nname: gateway-check\ndescription: Verify Gateway scoping\n---\nSmoke test.\n")
        boundary = "antnest-skill-" + secrets.token_hex(8)
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"artifact\"; filename=\"gateway-check.zip\"\r\n"
                "Content-Type: application/zip\r\n\r\n").encode() + archive.getvalue() + f"\r\n--{boundary}--\r\n".encode()
        status, _, published = request(base, "/api/admin/skills", "POST", {
            **auth, "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Idempotency-Key": "gateway-login-" + secrets.token_hex(12)}, data=body)
        assert status == 201, f"Gateway upload failed: {status} {published}"
        status, _, page = request(base, "/api/admin/skills", headers=auth)
        assert status == 200 and any(item["skill_id"] == published["skill_id"] for item in page["items"])
        status, _, spoofed = request(base, "/api/admin/skills", headers={
            **auth, "X-Antnest-Organization-ID": "org_" + secrets.token_hex(16)})
        assert status == 200 and spoofed == page, "Gateway accepted forged organization scope"
        result = {"scope": "Gateway login → Console → Registry", "unauthenticated": 401,
                  "authenticated": 200, "published": 201, "spoofedOrganizationIgnored": True}
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    finally:
        for name in reversed(started):
            docker("rm", "-f", name)


if __name__ == "__main__":
    main()
