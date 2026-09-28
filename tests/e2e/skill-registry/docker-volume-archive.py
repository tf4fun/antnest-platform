"""Check that Docker archive copy writes a named volume through an unstarted container."""

import json
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4


def docker(*args):
    return subprocess.check_output(("docker", *args), text=True).strip()


def main():
    suffix = uuid4().hex[:12]
    volume = f"antnest-skill-archive-check-{suffix}"
    preparer = f"antnest-skill-preparer-check-{suffix}"
    reader = f"antnest-skill-reader-check-{suffix}"
    created = []
    try:
        docker("volume", "create", volume)
        created.append(("volume", volume))
        docker("create", "--name", preparer, "--network", "none",
               "--mount", f"type=volume,source={volume},target=/skills,volume-nocopy",
               "debian:bookworm-slim", "sleep", "3600")
        created.append(("container", preparer))
        assert docker("inspect", "--format", "{{.State.Status}}", preparer) == "created"
        actual = json.loads(docker("inspect", preparer))[0]
        assert actual["HostConfig"]["NetworkMode"] == "none"
        assert any(m["Target"] == "/skills" and m["Source"] == volume
                   and m.get("VolumeOptions", {}).get("NoCopy") is True
                   for m in actual["HostConfig"]["Mounts"])
        assert any(m["Destination"] == "/skills" and m["Name"] == volume
                   and m["RW"] is True for m in actual["Mounts"])
        with tempfile.TemporaryDirectory(prefix="antnest-skill-archive-") as directory:
            source = Path(directory) / "SKILL.md"
            source.write_text("---\nname: archive-check\ndescription: Verify unstarted volume copy\n---\n")
            docker("cp", str(source), f"{preparer}:/skills/SKILL.md")
        assert docker("inspect", "--format", "{{.State.Status}}", preparer) == "created"
        observed = docker("run", "--rm", "--name", reader, "--network", "none",
                          "--mount", f"type=volume,source={volume},target=/skills,readonly",
                          "debian:bookworm-slim", "cat", "/skills/SKILL.md")
        assert "name: archive-check" in observed
        result = {"unstartedContainer": True, "volumeNoCopy": True,
                  "archiveCopyPersisted": True, "readOnlySecondMount": True,
                  "inspectMountFacts": True}
        evidence = Path(__file__).resolve().parents[3] / "artifacts/verification/skill-registry-volume-archive.json"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    finally:
        for kind, name in reversed(created):
            if kind == "container":
                docker("rm", "-f", name)
            else:
                docker("volume", "rm", name)


if __name__ == "__main__":
    main()
