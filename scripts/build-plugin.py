#!/usr/bin/env python3
"""Create a deterministic, credential-free native plugin upload archive."""

import argparse
import hashlib
import json
from pathlib import Path
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "plugin"
VERSION = "0.2.0"
DEFAULT_OUTPUT = ROOT / "downloads" / ("exam-plugin-" + VERSION + ".zip")
FILES = (
    ".codex-plugin/plugin.json",
    "skills/instructions/SKILL.md",
    "skills/instructions/agents/openai.yaml",
    "skills/instructions/scripts/exam_api.py",
    "skills/instructions/references/api.md",
)


def build(output=DEFAULT_OUTPUT):
    manifest = json.loads((SOURCE / FILES[0]).read_text(encoding="utf-8"))
    if manifest.get("version") != VERSION or manifest.get("skills") != "./skills/":
        raise ValueError("Plugin manifest version or native layout is invalid.")
    if manifest.get("name") != "gpt-dd9c158920e3b52a6a6416b5aa24f424":
        raise ValueError("Preserve the installed plugin identity when uploading a new version.")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # The file allowlist excludes environment files, credentials, archives and
    # developer documentation. Never recursively archive a checkout.
    contents = []
    for name in FILES:
        source = SOURCE / name
        if source.is_symlink() or not source.is_file():
            raise ValueError("A required plugin file is missing or is a symlink.")
        contents.append((name, source.read_bytes()))
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in contents:
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 6, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content, compresslevel=9)
    return {"file": str(output), "version": VERSION, "files": len(FILES), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(json.dumps(build(args.output)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
