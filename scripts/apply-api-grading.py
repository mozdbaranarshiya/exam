#!/usr/bin/env python3
"""Apply only the additive grading migration after checking the live schema.

Never reinstalls the initial schema or touches existing exam/student records.
Administrative credentials stay in the secure environment and HTTPS headers.
"""
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/202610060002_api_grading.sql'


def main():
    token = os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:
        raise SystemExit('Configure SUPABASE_ACCESS_TOKEN securely before applying the migration.')
    config = (ROOT / 'config.js').read_text()
    match = re.search(r"supabaseUrl:\s*'https://([a-z]{20})\.supabase\.co'", config)
    if not match:
        raise SystemExit('Cannot determine the configured Supabase project.')
    project = match.group(1)
    endpoint = f'https://api.supabase.com/v1/projects/{project}/database/query'

    def query(sql):
        request = urllib.request.Request(endpoint, method='POST',
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
            data=json.dumps({'query': sql}).encode())
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise SystemExit(f'Supabase schema request failed: HTTP {error.code}; no raw service details logged.') from None
        except urllib.error.URLError:
            raise SystemExit('Cannot reach Supabase Management API; TLS verification remains enabled.') from None

    inventory = query("""
      select to_regclass('public.api_tokens') is not null as tokens_present,
        to_regprocedure('public.grade_answer(uuid,uuid,numeric)') is not null as web_grading_present,
        to_regprocedure('exam_private.owner_for_token(text)') is not null as token_auth_present,
        to_regprocedure('public.api_grade_answer(text,bigint,uuid,uuid,numeric)') is not null as api_grading_present,
        exists(select 1 from information_schema.columns where table_schema='public'
          and table_name='api_tokens' and column_name='scopes') as scopes_present;
    """)[0]
    if inventory['api_grading_present'] and inventory['scopes_present']:
        print(json.dumps({'project': project, 'migration': MIGRATION.name, 'status': 'already_installed'}))
        return
    if (not all(inventory[k] for k in ['tokens_present', 'web_grading_present', 'token_auth_present'])
            or inventory['api_grading_present'] or inventory['scopes_present']):
        raise SystemExit('Unexpected schema state; additive migration was not executed. Inspect the schema first.')
    before = query('select count(*)::integer as count from public.api_tokens;')[0]['count']
    query(MIGRATION.read_text())
    after = query("""
      select count(*)::integer as count,
        count(*) filter (where scopes <> array['exam:create','results:read']::text[])::integer as expanded_keys
      from public.api_tokens;
    """)[0]
    if after['count'] != before or after['expanded_keys'] != 0:
        raise SystemExit('Unexpected existing-token state after migration; inspect before further deployment.')
    verified = query("""
      select to_regprocedure('public.api_grade_answer(text,bigint,uuid,uuid,numeric)') is not null as installed,
        has_function_privilege('anon','public.api_grade_answer(text,bigint,uuid,uuid,numeric)','execute') as api_allowed,
        has_function_privilege('anon','exam_private.grade_for_owner(uuid,bigint,uuid,uuid,numeric)','execute') as private_allowed;
    """)[0]
    if not verified['installed'] or not verified['api_allowed'] or verified['private_allowed']:
        raise SystemExit('Unexpected grading function grants; inspect before deployment.')
    print(json.dumps({'project': project, 'migration': MIGRATION.name, 'status': 'installed',
                      'existing_key_permissions': 'preserved', 'private_helper': 'inaccessible'}))


if __name__ == '__main__':
    main()
