#!/usr/bin/env python3
"""Offline checks of plugin transport, credential boundaries and upload layout."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


api = module("exam_plugin_api", ROOT / "plugin/skills/instructions/scripts/exam_api.py")
builder = module("exam_plugin_builder", ROOT / "scripts/build-plugin.py")
ENV = {"EXAM_TEACHER_TOKEN": "<opaque-secure-binding>"}
PAYLOAD = {
    "title": "آزمون ریاضی",
    "questions": [{"type": "mcq", "prompt": "۲+۲؟", "points": 2,
                   "options": ["۱", "۲", "۳", "۴"], "correct": 3},
                  {"type": "essay", "prompt": "توضیح", "points": 3.25}],
}
ID = "123456789012"
SUBMISSION_ID = "11111111-1111-4111-8111-111111111111"
QUESTION_ID = "22222222-2222-4222-8222-222222222222"
CREATED = {"id": int(ID), "title": PAYLOAD["title"], "question_count": 2,
           "total_points": 5.25, "url": api.SITE_URL + "/id/" + ID}
GRADE_RECEIPT = {"exam_id": int(ID), "submission_id": SUBMISSION_ID,
                 "question_id": QUESTION_ID, "score": 2.5,
                 "total_score": 4.5, "status": "graded"}


class Response:
    def __init__(self, value, status=200, raw=None):
        self.status = status
        self.raw = raw if raw is not None else json.dumps(value).encode()

    def read(self, limit):
        return self.raw[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Opener:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


class PluginClientTests(unittest.TestCase):
    def assert_error(self, code, operation):
        with self.assertRaises(api.ClientError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)
        self.assertNotIn(ENV["EXAM_TEACHER_TOKEN"], raised.exception.message)

    def test_create_sends_real_post_with_fourth_option_and_personal_key(self):
        opener = Opener(Response(CREATED, 201))
        self.assertEqual(api.create_exam(PAYLOAD, ENV, opener), CREATED)
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, api.BASE_URL + "/exams")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + ENV["EXAM_TEACHER_TOKEN"])
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data)["questions"][0]["correct"], 3)
        self.assertEqual(timeout, 30)

    def test_results_sends_get_and_preserves_provisional_scores(self):
        result = {"id": int(ID), "title": "آزمون", "questions": [], "submissions": [
            {"status": "pending", "total_score": 2, "answers": [{"score": None, "text": "untrusted student data"}]}]}
        opener = Opener(Response(result))
        self.assertEqual(api.get_results(ID, ENV, opener), result)
        request, _ = opener.calls[0]
        self.assertEqual(request.full_url, api.BASE_URL + "/exams/" + ID + "/results")
        self.assertEqual(request.method, "GET")
        self.assertIsNone(request.data)

    def test_missing_key_does_not_contact_network(self):
        opener = Opener(Response(CREATED, 201))
        self.assert_error("missing_teacher_token", lambda: api.create_exam(PAYLOAD, {}, opener))
        self.assertEqual(opener.calls, [])

    def test_admin_key_is_never_a_fallback(self):
        self.assert_error("missing_teacher_token", lambda: api.get_results(ID, {"SUPABASE_ACCESS_TOKEN": "synthetic-admin"}))

    def test_opaque_secure_proxy_placeholder_is_not_rejected(self):
        self.assertEqual(api.teacher_token(ENV), ENV["EXAM_TEACHER_TOKEN"])

    def test_blank_key_is_missing(self):
        self.assert_error("missing_teacher_token", lambda: api.teacher_token({"EXAM_TEACHER_TOKEN": " "}))

    def test_invalid_id_and_path_injection_are_rejected_before_network(self):
        for value in ("123", ID + "/../", "https://other.invalid", "۱۲۳۴۵۶۷۸۹۰۱۲", int(ID)):
            with self.subTest(value=value):
                self.assert_error("invalid_input", lambda: api.get_results(value, ENV))

    def test_direct_transport_only_accepts_supported_paths(self):
        self.assert_error("invalid_input", lambda: api.request_json("GET", "//other.invalid", ENV["EXAM_TEACHER_TOKEN"]))

    def test_input_normalizes_whitespace(self):
        payload = {"title": "  آزمون  ", "questions": [{"type": "essay", "prompt": "  سوال  ", "points": 0.01}]}
        self.assertEqual(api.validate_exam(payload)["title"], "آزمون")

    def test_points_boundaries_and_boolean_are_rejected(self):
        for value in (0, -1, 100.01, 0.001, True, float("nan"), float("inf"), "2"):
            with self.subTest(value=value):
                self.assert_error("invalid_input", lambda: api.validate_exam({"title": "Exam", "questions": [{"type": "essay", "prompt": "Q", "points": value}]}))

    def test_total_score_limit(self):
        item = {"type": "essay", "prompt": "Q", "points": 100}
        self.assert_error("invalid_input", lambda: api.validate_exam({"title": "Exam", "questions": [item] * 11}))

    def test_mcq_requires_four_options_and_zero_based_index(self):
        for options, correct in ((["A"] * 3, 0), (["A"] * 4, 4), (["A"] * 4, True), ([""] * 4, 1)):
            payload = {"title": "Exam", "questions": [{"type": "mcq", "prompt": "Q", "points": 1, "options": options, "correct": correct}]}
            self.assert_error("invalid_input", lambda: api.validate_exam(payload))

    def test_essay_must_omit_answer_key(self):
        self.assert_error("invalid_input", lambda: api.validate_exam({"title": "Exam", "questions": [{"type": "essay", "prompt": "Q", "points": 1, "correct": None}]}))

    def test_unknown_fields_and_types_are_rejected(self):
        for payload in ({**PAYLOAD, "owner": "other"}, {"title": "Exam", "questions": [{"type": "unknown", "prompt": "Q", "points": 1}]}):
            self.assert_error("invalid_input", lambda: api.validate_exam(payload))

    def test_request_size_limit_uses_utf8_bytes(self):
        payload = {"title": "Exam", "questions": [{"type": "essay", "prompt": "س" * 5000, "points": 1}] * 30}
        self.assert_error("payload_too_large", lambda: api.validate_exam(payload))

    def test_json_file_valid_invalid_missing_and_large(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            path.write_text(json.dumps(PAYLOAD, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(api.read_input(path), PAYLOAD)
            path.write_bytes(b"\xff")
            self.assert_error("invalid_json", lambda: api.read_input(path))
            path.write_bytes(b" " * (api.MAX_BODY_BYTES + 1))
            self.assert_error("payload_too_large", lambda: api.read_input(path))
            self.assert_error("input_unavailable", lambda: api.read_input(Path(directory) / "missing"))

    def test_401_403_and_redirect_are_sanitized(self):
        for status, code in ((401, "unauthorized"), (403, "forbidden"), (302, "redirect_blocked"), (429, "rate_limited"), (502, "service_error")):
            raw = io.BytesIO(ENV["EXAM_TEACHER_TOKEN"].encode())
            error = urllib.error.HTTPError(api.BASE_URL, status, "secret must not be echoed", {}, raw)
            self.assert_error(code, lambda: api.get_results(ID, ENV, Opener(error=error)))

    def test_network_errors_do_not_leak_exception_or_key(self):
        for error in (urllib.error.URLError(ENV["EXAM_TEACHER_TOKEN"]), socket.timeout(ENV["EXAM_TEACHER_TOKEN"])):
            self.assert_error("network_error", lambda: api.get_results(ID, ENV, Opener(error=error)))

    def test_creation_never_retries_after_timeout(self):
        opener = Opener(error=socket.timeout("synthetic"))
        self.assert_error("network_error", lambda: api.create_exam(PAYLOAD, ENV, opener))
        self.assertEqual(len(opener.calls), 1)

    def test_redirect_handler_refuses_new_origin(self):
        self.assertIsNone(api.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://other.invalid"))

    def test_standard_https_opener_preserves_tls_verification(self):
        opener = Opener(Response(CREATED, 201))
        with patch.object(api.urllib.request, "build_opener", return_value=opener) as factory:
            api.create_exam(PAYLOAD, ENV)
        self.assertIsInstance(factory.call_args.args[0], api.NoRedirect)
        self.assertEqual(factory.call_args.kwargs, {})

    def test_invalid_json_status_and_large_response_are_rejected(self):
        for response, code in ((Response(None, raw=b"not-json"), "invalid_response"),
                               (Response(None, raw=b"{}", status=204), "invalid_response"),
                               (Response(None, raw=b" " * (api.MAX_RESPONSE_BYTES + 1)), "response_too_large")):
            self.assert_error(code, lambda: api.get_results(ID, ENV, Opener(response)))

    def test_created_link_must_match_returned_id_and_known_site(self):
        for change in ({"url": "https://other.invalid/id/" + ID}, {"id": "bad"}, {"total_points": float("nan")}, {"question_count": True}):
            self.assert_error("invalid_response", lambda: api.create_exam(PAYLOAD, ENV, Opener(Response({**CREATED, **change}, 201))))

    def test_results_must_match_requested_owner_exam(self):
        result = {"id": 999999999999, "title": "Other", "questions": [], "submissions": []}
        self.assert_error("invalid_response", lambda: api.get_results(ID, ENV, Opener(Response(result))))

    def test_cli_reports_json_error_without_secret_or_trace(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = api.main(["results", "--id", ID, "--teacher-token", ENV["EXAM_TEACHER_TOKEN"]])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], "invalid_arguments")
        self.assertNotIn(ENV["EXAM_TEACHER_TOKEN"], output.getvalue())

    def test_grade_sends_patch_with_saved_ids_and_numeric_score(self):
        opener = Opener(Response(GRADE_RECEIPT))
        result = api.grade_answer(ID, SUBMISSION_ID, QUESTION_ID, "2.50", ENV, opener)
        self.assertEqual(result, GRADE_RECEIPT)
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, api.BASE_URL + "/exams/" + ID + "/grades")
        self.assertEqual(request.method, "PATCH")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + ENV["EXAM_TEACHER_TOKEN"])
        self.assertEqual(json.loads(request.data), {"submission_id": SUBMISSION_ID, "question_id": QUESTION_ID, "score": 2.5})
        self.assertEqual(timeout, 30)

    def test_grade_zero_and_full_points_are_allowed(self):
        for score in (0, "0.00", 100, "100.00"):
            self.assertEqual(api.validate_grade(ID, SUBMISSION_ID, QUESTION_ID, score)["score"], float(score))

    def test_grade_invalid_scores_are_rejected_before_network(self):
        for score in (-0.01, 100.01, "0.001", True, "NaN", "Infinity", float("nan"), "not-a-score", None):
            with self.subTest(score=score):
                opener = Opener(Response(GRADE_RECEIPT))
                self.assert_error("invalid_input", lambda: api.grade_answer(ID, SUBMISSION_ID, QUESTION_ID, score, ENV, opener))
                self.assertEqual(opener.calls, [])

    def test_grade_invalid_exam_submission_and_question_ids_are_rejected(self):
        for identifier, submission, question in (("123", SUBMISSION_ID, QUESTION_ID),
                (ID, "other.invalid", QUESTION_ID), (ID, SUBMISSION_ID, "not-a-uuid"),
                (ID + "/../", SUBMISSION_ID, QUESTION_ID),
                (ID, SUBMISSION_ID.replace("-", ""), QUESTION_ID)):
            opener = Opener(Response(GRADE_RECEIPT))
            self.assert_error("invalid_input", lambda: api.grade_answer(identifier, submission, question, 2.5, ENV, opener))
            self.assertEqual(opener.calls, [])

    def test_grade_missing_personal_token_and_admin_only_do_not_send(self):
        opener = Opener(Response(GRADE_RECEIPT))
        self.assert_error("missing_teacher_token", lambda: api.grade_answer(ID, SUBMISSION_ID, QUESTION_ID, 2.5, {"SUPABASE_ACCESS_TOKEN": "synthetic-admin"}, opener))
        self.assertEqual(opener.calls, [])

    def test_grade_denied_scope_owner_and_bounds_errors_are_sanitized(self):
        for status, code in ((400, "invalid_input"), (401, "unauthorized"), (403, "forbidden"), (404, "not_found")):
            raw = io.BytesIO(ENV["EXAM_TEACHER_TOKEN"].encode())
            error = urllib.error.HTTPError(api.BASE_URL, status, "private upstream message", {}, raw)
            self.assert_error(code, lambda: api.grade_answer(ID, SUBMISSION_ID, QUESTION_ID, 2.5, ENV, Opener(error=error)))

    def test_grade_receipt_must_match_exam_answer_score_and_status(self):
        for change in ({"exam_id": 999999999999}, {"submission_id": QUESTION_ID}, {"question_id": SUBMISSION_ID},
                       {"score": 0}, {"score": True}, {"total_score": -1}, {"total_score": float("nan")}, {"status": "received"}):
            self.assert_error("invalid_response", lambda: api.grade_answer(ID, SUBMISSION_ID, QUESTION_ID, 2.5, ENV,
                Opener(Response({**GRADE_RECEIPT, **change}))))

    def test_grade_timeout_never_repeats_write(self):
        opener = Opener(error=socket.timeout("synthetic"))
        self.assert_error("network_error", lambda: api.grade_answer(ID, SUBMISSION_ID, QUESTION_ID, 2.5, ENV, opener))
        self.assertEqual(len(opener.calls), 1)

    def test_cli_grade_dispatches_without_exposing_credentials(self):
        output = io.StringIO()
        with patch.object(api, "grade_answer", return_value=GRADE_RECEIPT) as operation:
            with contextlib.redirect_stdout(output):
                result = api.main(["grade", "--exam-id", ID, "--submission-id", SUBMISSION_ID,
                    "--question-id", QUESTION_ID, "--score", "2.5"])
        self.assertEqual(result, 0)
        operation.assert_called_once_with(ID, SUBMISSION_ID, QUESTION_ID, "2.5")
        self.assertEqual(json.loads(output.getvalue()), GRADE_RECEIPT)


class PluginPackageTests(unittest.TestCase):
    def test_zip_has_native_root_preserved_identity_and_only_safe_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "plugin.zip"
            result = builder.build(output)
            self.assertEqual(result["version"], "0.2.0")
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), list(builder.FILES))
                self.assertIsNone(archive.testzip())
                manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
                self.assertEqual(manifest["name"], "gpt-dd9c158920e3b52a6a6416b5aa24f424")
                self.assertEqual(manifest["version"], "0.2.0")
                self.assertEqual(manifest["interface"]["capabilities"], ["skills"])
                self.assertEqual(manifest["skills"], "./skills/")
                for name in archive.namelist():
                    self.assertFalse(name.startswith("/"))
                    self.assertNotIn("..", Path(name).parts)
                    self.assertEqual(archive.read(name), (builder.SOURCE / name).read_bytes())
                    self.assertNotIn(ENV["EXAM_TEACHER_TOKEN"].encode(), archive.read(name))

    def test_archive_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "one.zip", Path(directory) / "two.zip"
            self.assertEqual(builder.build(first)["sha256"], builder.build(second)["sha256"])
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_downloadable_zip_matches_current_plugin_source(self):
        self.assertTrue(builder.DEFAULT_OUTPUT.is_file(), "Run scripts/build-plugin.py to create the upload file.")
        with zipfile.ZipFile(builder.DEFAULT_OUTPUT) as archive:
            self.assertEqual(archive.namelist(), list(builder.FILES))
            self.assertIsNone(archive.testzip())
            for name in builder.FILES:
                self.assertEqual(archive.read(name), (builder.SOURCE / name).read_bytes(),
                                 "Rebuild the upload ZIP after changing bundled source: " + name)

    def test_skill_contains_executable_workflow_and_secure_boundaries(self):
        skill = (builder.SOURCE / "skills/instructions/SKILL.md").read_text()
        for required in ("scripts/exam_api.py", "EXAM_TEACHER_TOKEN", "create --input", "results --id", "grade --exam-id", "pending", "score: null", "skill_root", "Do not report", "MCQs are scored automatically"):
            self.assertIn(required, skill)
        self.assertIn("It does not register callable tools", skill)
        self.assertNotIn("mcpServers", json.dumps(json.loads((builder.SOURCE / ".codex-plugin/plugin.json").read_text())))


if __name__ == "__main__":
    unittest.main(verbosity=2)
