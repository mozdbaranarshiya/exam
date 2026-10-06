#!/usr/bin/env python3
"""Personal teacher API client. Standard library only; never prints credentials."""

import argparse
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import socket
import sys
import urllib.error
import urllib.request

BASE_URL = "https://pukanizbahswrupscfmg.supabase.co/functions/v1/exam-api"
SITE_URL = "https://mozdbaranarshiya.github.io/exam"
TOKEN_VARIABLE = "EXAM_TEACHER_TOKEN"
MAX_BODY_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
TIMEOUT_SECONDS = 30
EXAM_ID = re.compile(r"[0-9]{12}\Z")
UUID_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")


class ClientError(Exception):
    """Only explicitly constructed, credential-free messages reach output."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def text(value, maximum, label):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise ClientError("invalid_input", f"{label} must contain 1 to {maximum} characters.")
    return value.strip()


def validate_exam(value):
    if not isinstance(value, dict) or set(value) != {"title", "questions"}:
        raise ClientError("invalid_input", "Provide an object containing only title and questions.")
    title = text(value["title"], 200, "Title")
    items = value["questions"]
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ClientError("invalid_input", "Provide between 1 and 100 questions.")
    questions = []
    total = Decimal(0)
    for index, item in enumerate(items, 1):
        label = f"Question {index}"
        if not isinstance(item, dict) or not set(item).issubset({"type", "prompt", "points", "options", "correct"}):
            raise ClientError("invalid_input", f"{label} contains unsupported fields.")
        prompt = text(item.get("prompt"), 5000, f"{label} prompt")
        points = item.get("points")
        if isinstance(points, bool) or not isinstance(points, (int, float)):
            raise ClientError("invalid_input", f"{label} points must be a number.")
        try:
            number = Decimal(str(points))
            if not number.is_finite() or not 0 < number <= 100 or number * 100 != (number * 100).to_integral_value():
                raise InvalidOperation()
        except (InvalidOperation, ValueError):
            raise ClientError("invalid_input", f"{label} points must be greater than 0 and at most 100, with at most two decimal places.") from None
        total += number
        if total > 1000:
            raise ClientError("invalid_input", "The total score must not exceed 1000 points.")
        question = {"type": item.get("type"), "prompt": prompt, "points": points}
        if item.get("type") == "mcq":
            options = item.get("options")
            if not isinstance(options, list) or len(options) != 4:
                raise ClientError("invalid_input", f"{label} must have exactly four options.")
            question["options"] = [text(option, 1000, f"{label} option") for option in options]
            correct = item.get("correct")
            if isinstance(correct, bool) or not isinstance(correct, int) or not 0 <= correct <= 3:
                raise ClientError("invalid_input", f"{label} correct must be an integer from 0 to 3.")
            question["correct"] = correct
        elif item.get("type") == "essay":
            if "options" in item or "correct" in item:
                raise ClientError("invalid_input", f"{label} is an essay and must omit options and correct.")
        else:
            raise ClientError("invalid_input", f"{label} type must be mcq or essay.")
        questions.append(question)
    result = {"title": title, "questions": questions}
    encode_body(result)
    return result


def encode_body(value):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_BODY_BYTES:
        raise ClientError("payload_too_large", "The exam JSON must not exceed 256 KiB.")
    return raw


def read_input(path):
    try:
        with Path(path).open("rb") as source:
            raw = source.read(MAX_BODY_BYTES + 1)
    except (OSError, ValueError):
        raise ClientError("input_unavailable", "The exam input file could not be read.") from None
    if len(raw) > MAX_BODY_BYTES:
        raise ClientError("payload_too_large", "The exam JSON must not exceed 256 KiB.")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ClientError("invalid_json", "The input file must contain valid UTF-8 JSON.") from None
    return validate_exam(value)


def teacher_token(environment):
    token = environment.get(TOKEN_VARIABLE)
    # Keep opaque proxy placeholders intact; do not impose a token format.
    if not isinstance(token, str) or not token.strip():
        raise ClientError("missing_teacher_token", "Configure EXAM_TEACHER_TOKEN through secure execution-environment settings.")
    return token


def request_json(method, path, token, payload=None, opener=None):
    supported = ((method, path) == ("POST", "/exams")
                 or (method == "GET" and re.fullmatch(r"/exams/[0-9]{12}/results", path))
                 or (method == "PATCH" and re.fullmatch(r"/exams/[0-9]{12}/grades", path)))
    if not supported:
        raise ClientError("invalid_input", "Unsupported API operation.")
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    data = None
    if payload is not None:
        data = encode_body(payload)
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(BASE_URL + path, headers=headers, method=method, data=data)
    client = opener or urllib.request.build_opener(NoRedirect())
    try:
        with client.open(request, timeout=TIMEOUT_SECONDS) as response:
            expected_status = 201 if method == "POST" else 200
            if response.status != expected_status:
                raise ClientError("invalid_response", "The service returned an unexpected HTTP status.")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        codes = {
            400: ("invalid_input", "The service rejected the input. For grading, use an essay score within its declared points."),
            401: ("unauthorized", "The personal teacher key is invalid, expired, or revoked."),
            403: ("forbidden", "This exam is unavailable for this teacher or key."),
            404: ("not_found", "The requested API endpoint or submitted answer is unavailable."),
            413: ("payload_too_large", "The exam JSON must not exceed 256 KiB."),
            429: ("rate_limited", "The service is busy. Wait before trying again."),
        }
        code, message = codes.get(status, ("service_error", "The exam service could not complete the request."))
        if 300 <= status < 400:
            code, message = "redirect_blocked", "An HTTP redirect was refused to protect the teacher key."
        raise ClientError(code, message) from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, ValueError):
        raise ClientError("network_error", "The HTTPS request failed. Check runtime network access; verify the outcome before repeating a write.") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ClientError("response_too_large", "The service response exceeds the safe output limit.")
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ClientError("invalid_response", "The service did not return valid UTF-8 JSON.") from None
    if not isinstance(result, dict):
        raise ClientError("invalid_response", "The service response must be a JSON object.")
    return result


def create_exam(payload, environment=None, opener=None):
    payload = validate_exam(payload)
    token = teacher_token(os.environ if environment is None else environment)
    result = request_json("POST", "/exams", token, payload, opener)
    identifier = str(result.get("id", ""))
    points = result.get("total_points")
    count = result.get("question_count")
    if (not EXAM_ID.fullmatch(identifier) or not isinstance(result.get("title"), str)
            or isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 100
            or isinstance(points, bool) or not isinstance(points, (int, float))
            or not 0 < points <= 1000
            or result.get("url") != SITE_URL + "/id/" + identifier):
        raise ClientError("invalid_response", "The service returned an invalid exam or student link.")
    return {key: result[key] for key in ("id", "title", "question_count", "total_points", "url")}


def get_results(identifier, environment=None, opener=None):
    if not isinstance(identifier, str) or not EXAM_ID.fullmatch(identifier):
        raise ClientError("invalid_input", "The exam ID must contain exactly twelve ASCII digits.")
    token = teacher_token(os.environ if environment is None else environment)
    result = request_json("GET", "/exams/" + identifier + "/results", token, opener=opener)
    if (str(result.get("id")) != identifier or not isinstance(result.get("title"), str)
            or not isinstance(result.get("questions"), list) or not isinstance(result.get("submissions"), list)):
        raise ClientError("invalid_response", "The service returned invalid exam results.")
    return result


def validate_grade(identifier, submission_id, question_id, score):
    if not isinstance(identifier, str) or not EXAM_ID.fullmatch(identifier):
        raise ClientError("invalid_input", "The exam ID must contain exactly twelve ASCII digits.")
    for value, label in ((submission_id, "Submission"), (question_id, "Question")):
        if not isinstance(value, str) or not UUID_ID.fullmatch(value):
            raise ClientError("invalid_input", f"{label} ID must be a hyphenated UUID from the saved results.")
    if isinstance(score, bool) or not isinstance(score, (str, int, float, Decimal)):
        raise ClientError("invalid_input", "The essay score must be a number from 0 to 100, with at most two decimal places.")
    try:
        number = Decimal(str(score))
        if (not number.is_finite() or not 0 <= number <= 100
                or number * 100 != (number * 100).to_integral_value()):
            raise InvalidOperation()
    except (InvalidOperation, ValueError):
        raise ClientError("invalid_input", "The essay score must be a number from 0 to 100, with at most two decimal places.") from None
    return {"submission_id": submission_id.lower(), "question_id": question_id.lower(), "score": float(number)}


def grade_answer(identifier, submission_id, question_id, score, environment=None, opener=None):
    payload = validate_grade(identifier, submission_id, question_id, score)
    token = teacher_token(os.environ if environment is None else environment)
    result = request_json("PATCH", "/exams/" + identifier + "/grades", token, payload, opener)
    saved_score = result.get("score")
    total = result.get("total_score")
    if (str(result.get("exam_id")) != identifier
            or result.get("submission_id") != payload["submission_id"]
            or result.get("question_id") != payload["question_id"]
            or isinstance(saved_score, bool) or not isinstance(saved_score, (int, float))
            or saved_score != payload["score"]
            or isinstance(total, bool) or not isinstance(total, (int, float)) or not 0 <= total <= 1000
            or result.get("status") not in ("pending", "graded")):
        raise ClientError("invalid_response", "The service returned an invalid grading receipt. Verify the saved grade in the dashboard.")
    return {key: result[key] for key in ("exam_id", "submission_id", "question_id", "score", "total_score", "status")}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's raw message can echo user-supplied arguments, including a
        # mistakenly pasted secret. Keep the CLI contract strict and sanitized.
        raise ClientError("invalid_arguments", "Use create --input PATH, results --id ID, or grade --exam-id ID --submission-id UUID --question-id UUID --score NUMBER. Credentials are read from secure environment settings only.")


def main(arguments=None):
    parser = JsonArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True, parser_class=JsonArgumentParser)
    create = commands.add_parser("create", help="Create an exam from a nonsecret JSON file")
    create.add_argument("--input", required=True)
    results = commands.add_parser("results", help="Read the authenticated teacher's results")
    results.add_argument("--id", required=True)
    grade = commands.add_parser("grade", help="Register or change an essay answer score")
    grade.add_argument("--exam-id", required=True)
    grade.add_argument("--submission-id", required=True)
    grade.add_argument("--question-id", required=True)
    grade.add_argument("--score", required=True)
    try:
        args = parser.parse_args(arguments)
        if args.command == "create":
            result = create_exam(read_input(args.input))
        elif args.command == "results":
            result = get_results(args.id)
        else:
            result = grade_answer(args.exam_id, args.submission_id, args.question_id, args.score)
    except ClientError as error:
        print(json.dumps({"error": {"code": error.code, "message": error.message}}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
