#!/usr/bin/env python3
"""Deploy exam-api using the official Supabase Management API and existing token.

Run from any directory: python3 scripts/deploy-actions.py
SUPABASE_ACCESS_TOKEN must be injected securely by the environment. The standard
library respects the cloud HTTPS proxy; credentials are never written to disk.
This does not install SQL or alter Authentication or other Edge Functions.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parent.parent


def stop(message):
    raise SystemExit(message)


def main():
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        stop("Missing SUPABASE_ACCESS_TOKEN; configure it securely in environment settings.")

    config = (ROOT / "config.js").read_text(encoding="utf-8")
    project_match = re.search(r"supabaseUrl:\s*'https://([a-z]{20})\.supabase\.co'", config)
    key_match = re.search(r"supabaseKey:\s*'(sb_publishable_[A-Za-z0-9_-]+)'", config)
    if not project_match or not key_match:
        stop("Expected a Supabase project URL and publishable key in config.js.")
    project = project_match.group(1)
    base = f"https://api.supabase.com/v1/projects/{project}"

    def management(path, body=None, content_type=None):
        headers = {"Authorization": "Bearer " + token}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            base + path,
            data=body,
            headers=headers,
            method="POST" if body is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as error:
            # Do not dump request headers, secret payloads, or service error details.
            stop(f"Supabase management request {path} failed: HTTP {error.code}.")
        except urllib.error.URLError:
            stop("Cannot reach api.supabase.com; check the configured HTTPS proxy/network.")

    # This additive update leaves unrelated project secrets in place.
    management(
        "/secrets",
        json.dumps([{"name": "EXAM_PUBLISHABLE_KEY", "value": key_match.group(1)}]).encode(),
        "application/json",
    )

    source = (ROOT / "supabase/functions/exam-api/index.ts").read_bytes()
    boundary = "exam-deploy-" + uuid.uuid4().hex
    delimiter = b"--" + boundary.encode()
    metadata = json.dumps({
        "entrypoint_path": "index.ts",
        "verify_jwt": False,
        "name": "exam-api",
    }).encode()
    body = (
        delimiter
        + b'\r\nContent-Disposition: form-data; name="metadata"\r\n'
        + b"Content-Type: application/json\r\n\r\n"
        + metadata + b"\r\n"
        + delimiter
        + b'\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\n'
        + b"Content-Type: application/typescript\r\n\r\n"
        + source + b"\r\n"
        + delimiter + b"--\r\n"
    )
    # Supabase bundles the TypeScript source; Docker and a local Deno install are unnecessary.
    deployed = management(
        "/functions/deploy?slug=exam-api",
        body,
        "multipart/form-data; boundary=" + boundary,
    )
    verified = management("/functions/exam-api")
    if (verified.get("status") != "ACTIVE" or verified.get("verify_jwt") is not False
            or verified.get("version") != deployed.get("version")):
        stop("Deployment metadata did not confirm an active function with verify_jwt=false.")

    request = urllib.request.Request(
        f"https://{project}.supabase.co/functions/v1/exam-api/exams",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            stop(f"Unauthorized smoke test unexpectedly returned HTTP {response.status}.")
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read())
        except (ValueError, UnicodeDecodeError):
            stop("The deployed endpoint did not return a JSON error.")
        if error.code != 401 or result.get("error", {}).get("code") != "unauthorized":
            stop(f"Unauthorized smoke test failed: HTTP {error.code}.")
    except urllib.error.URLError:
        stop("Cannot reach the deployed endpoint; check the configured network.")

    print(json.dumps({
        "project": project,
        "function": "exam-api",
        "status": verified["status"],
        "version": verified["version"],
        "verify_jwt": verified["verify_jwt"],
        "source_sha256": hashlib.sha256(source).hexdigest(),
        "bundle_sha256": verified.get("ezbr_sha256"),
        "unauthorized_smoke_test": "passed",
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Deployment could not complete ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
