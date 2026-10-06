#!/usr/bin/env python3
"""Exercise real Supabase/Auth/Actions; clean up only accounts created by this run.

Requires the project's administrative SUPABASE_ACCESS_TOKEN in the environment.
Passwords and teacher tokens are generated in memory and never printed or saved.
"""
import json
import os
from pathlib import Path
import re
import secrets
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
CONFIG = (ROOT / 'config.js').read_text()
URL = re.search(r"supabaseUrl:\s*'([^']+)'", CONFIG).group(1)
KEY = re.search(r"supabaseKey:\s*'([^']+)'", CONFIG).group(1)
REF = URL.split('//')[1].split('.')[0]
ADMIN = os.environ.get('SUPABASE_ACCESS_TOKEN')
if not ADMIN:
    raise SystemExit('SUPABASE_ACCESS_TOKEN is required; supply it through secure environment settings.')
CREATED = []
CHECKS = 0


def call(path, body=None, token=None, method='POST', expected=200, code=None):
    headers = {'apikey': KEY, 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(URL + path, headers=headers, method=method,
                                     data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    data = json.loads(raw) if raw else {}
    accepted = [expected] if isinstance(expected, int) else expected
    if status not in accepted:
        failure = data.get('code') or data.get('error_code')
        if isinstance(data.get('error'), dict):
            failure = data['error'].get('code')
        raise RuntimeError(f'{path.split("?")[0]}: HTTP {status}, error code {failure}')
    if code:
        actual = data.get('code') or data.get('error_code')
        if isinstance(data.get('error'), dict):
            actual = data['error'].get('code')
        assert actual == code, f'Unexpected error code for {path.split("?")[0]}'
    return data


def rpc(name, body=None, token=None, **kwargs):
    return call('/rest/v1/rpc/' + name, body or {}, token, **kwargs)


def check(condition, label):
    global CHECKS
    assert condition, label
    CHECKS += 1
    print('PASS:', label)


def teacher():
    username = 'onb_' + secrets.token_hex(6)
    email = username + '@teachers.exam.invalid'
    password = secrets.token_urlsafe(32)
    signup = call('/auth/v1/signup', {
        'email': email, 'password': password,
        'data': {'username': username, 'first_name': 'آزمایشی', 'last_name': 'بررسی', 'phone': '09120000000'}
    })
    identifier = str(uuid.UUID(signup['user']['id']))
    CREATED.append((identifier, email))
    check(bool(signup.get('access_token')), 'Teacher signup creates an immediately usable session')
    login = call('/auth/v1/token?grant_type=password', {'email': email, 'password': password})
    check(login['user']['id'] == identifier, 'Username-backed password login identifies the correct teacher')
    refreshed = call('/auth/v1/token?grant_type=refresh_token', {'refresh_token': login['refresh_token']})
    check(refreshed['user']['id'] == identifier, 'Session refresh works')
    return refreshed['access_token']


def cleanup():
    if not CREATED:
        return
    predicates = []
    for identifier, email in CREATED:
        assert re.fullmatch(r'[a-z0-9_]+@teachers\.exam\.invalid', email)
        identifier = str(uuid.UUID(identifier))
        predicates.append(f"(id = '{identifier}'::uuid AND email = '{email}')")
    query = 'DELETE FROM auth.users WHERE ' + ' OR '.join(predicates) + ' RETURNING id;'
    endpoint = 'https://api.supabase.com/v1/projects/' + REF + '/database/query'
    headers = {'Authorization': 'Bearer ' + ADMIN, 'Content-Type': 'application/json'}
    request = urllib.request.Request(endpoint, headers=headers, method='POST', data=json.dumps({'query': query}).encode())
    with urllib.request.urlopen(request, timeout=30) as response:
        deleted = json.load(response)
    assert {row['id'] for row in deleted} == {identifier for identifier, _ in CREATED}, 'Test account cleanup mismatch'
    print('CLEANUP: deleted only the two test accounts and their cascading exam data')


try:
    a, b = teacher(), teacher()
    questions = [
        {'type': 'mcq', 'prompt': 'آزمون فنی: حاصل ۲+۲؟', 'points': 2, 'options': ['۱', '۲', '۳', '۴'], 'correct': 3},
        {'type': 'essay', 'prompt': 'آزمون فنی: توضیح پاسخ', 'points': 3.5},
    ]
    created = rpc('create_exam', {'p_title': 'آزمون فنی موقت', 'p_questions': questions}, a)
    exam_id = created['id']
    check(len(str(exam_id)) == 12 and created['total_points'] == 5.5, 'Exam creation returns a twelve-digit ID and accurate points')
    check(any(e['id'] == exam_id for e in rpc('list_exams', token=a)), 'Teacher can list their own exam')
    check(rpc('list_exams', token=b) == [], 'A second teacher cannot list the first teacher’s exam')
    public = rpc('get_exam', {'p_exam_id': exam_id})
    check(all('correct' not in q for q in public['questions']), 'Public question data excludes every answer key')
    mcq, essay = public['questions']
    payload = {'p_exam_id': exam_id, 'p_first_name': 'دانش‌آموز آزمایشی', 'p_last_name': 'بررسی',
               'p_answers': {mcq['id']: {'choice': 3}, essay['id']: {'text': 'پاسخ آزمایشی'}}}
    receipt = rpc('submit_exam', payload)
    check(receipt['status'] == 'received' and 'total_score' not in receipt, 'Anonymous student receives a receipt without grades')
    result = rpc('get_results', {'p_exam_id': exam_id}, a)
    submission = result['submissions'][0]
    check(submission['total_score'] == 2 and submission['status'] == 'pending', 'Correct MCQ is scored server-side and essay remains pending')
    rpc('get_results', {'p_exam_id': exam_id}, b, expected=[403, 500], code='42501')
    check(True, 'Cross-teacher result access is rejected')
    call('/rest/v1/questions?select=correct', method='GET', expected=[401, 403], code='42501')
    check(True, 'Anonymous direct answer-key table reads are rejected')
    rpc('grade_answer', {'p_submission_id': submission['id'], 'p_question_id': essay['id'], 'p_score': 4}, a,
        expected=[400, 500], code='22023')
    check(True, 'Essay grades above the declared question points are rejected')
    graded = rpc('grade_answer', {'p_submission_id': submission['id'], 'p_question_id': essay['id'], 'p_score': 2.5}, a)
    check(graded['total_score'] == 4.5 and graded['status'] == 'graded', 'Essay grading updates the total and final status')
    invalid = {**payload, 'p_answers': {mcq['id']: {'choice': 9}, essay['id']: {'text': 'نامعتبر'}}}
    rpc('submit_exam', invalid, expected=[400, 500], code='22023')
    check(len(rpc('get_results', {'p_exam_id': exam_id}, a)['submissions']) == 1, 'Invalid student answers roll back atomically')
    teacher_key = rpc('issue_api_token', token=a)['token']
    other_key = rpc('issue_api_token', token=b)['token']
    action = '/functions/v1/exam-api/exams'
    call(action, {'title': 'نباید ساخته شود', 'questions': questions}, expected=401, code='unauthorized')
    check(True, 'Actions rejects requests missing a teacher key')
    action_exam = call(action, {'title': 'آزمون موقت Actions', 'questions': questions}, teacher_key, expected=201)
    check(action_exam['url'] == 'https://mozdbaranarshiya.github.io/exam/id/' + str(action_exam['id']), 'Live GPT Action creates an exam and returns the correct Pages link')
    action_results = call(action + '/' + str(exam_id) + '/results', token=teacher_key, method='GET')
    check(action_results['submissions'][0]['total_score'] == 4.5, 'Live GPT Action reports the saved teacher grades')
    call(action + '/' + str(exam_id) + '/results', token=other_key, method='GET', expected=403, code='forbidden')
    check(True, 'A different teacher key cannot access the exam’s results')
    rpc('revoke_api_tokens', token=a)
    call(action + '/' + str(exam_id) + '/results', token=teacher_key, method='GET', expected=401, code='unauthorized')
    check(True, 'Revoked teacher keys stop working immediately in the deployed Action')
    check(len(rpc('get_results', {'p_exam_id': exam_id}, a)['submissions']) == 1, 'Teacher session remains usable after API-key revocation')
    print(f'LIVE RESULT: {CHECKS} checks passed against deployed Supabase/Auth/Actions')
finally:
    cleanup()
