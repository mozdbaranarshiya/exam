-- Add teacher-token grading without reinstalling or changing stored exam data.
-- The web panel and API share the same ownership, locking and score validation.
begin;

-- Existing keys keep their original permissions. Newly issued keys opt in to grading.
alter table public.api_tokens add column scopes text[] not null
  default array['exam:create', 'results:read']::text[]
  check (scopes <@ array['exam:create', 'results:read', 'grade:essay']::text[]);

create or replace function public.issue_api_token()
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid := exam_private.require_teacher(); v_token text; v_expires timestamptz;
begin
  perform 1 from public.teacher_profiles where id = u for update;
  if (select count(*) from public.api_tokens where owner_id = u and revoked_at is null and expires_at > now()) >= 5 then
    raise exception using errcode = '22023', message = 'At most five active API keys are allowed; revoke keys first';
  end if;
  v_token := 'exam_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');
  insert into public.api_tokens(owner_id, token_hash, scopes)
    values (u, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
      array['exam:create', 'results:read', 'grade:essay']::text[]) returning expires_at into v_expires;
  return jsonb_build_object('token', v_token, 'expires_at', v_expires);
end;
$$;

create function exam_private.grade_for_owner(
  p_owner uuid, p_exam_id bigint, p_submission_id uuid, p_question_id uuid, p_score numeric
)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v_exam bigint; v_points numeric; v_type text; v_total numeric; v_status text;
begin
  -- Lock the whole submission so concurrent grades keep its aggregate consistent.
  select s.exam_id into v_exam from public.submissions s
    join public.exams e on e.id = s.exam_id
    where s.id = p_submission_id and e.owner_id = p_owner
      and (p_exam_id is null or s.exam_id = p_exam_id)
    for update of s;
  if v_exam is null then
    raise exception using errcode = '42501', message = 'Submission unavailable';
  end if;

  select q.points, q.type into v_points, v_type from public.questions q
    where q.id = p_question_id and q.exam_id = v_exam;
  if v_points is null then
    raise exception using errcode = '42501', message = 'Question unavailable';
  end if;
  if v_type <> 'essay' then
    raise exception using errcode = '22023', message = 'Only essay answers can be graded';
  end if;
  if not exists(select 1 from public.answers
    where submission_id = p_submission_id and question_id = p_question_id and exam_id = v_exam) then
    raise exception using errcode = 'P0002', message = 'Answer unavailable';
  end if;
  if p_score is null or p_score < 0 or p_score > v_points or trunc(p_score, 2) <> p_score
    or p_score::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023',
      message = 'Score must be between zero and the question points, with up to two decimal places';
  end if;

  update public.answers set score = p_score
    where submission_id = p_submission_id and question_id = p_question_id;
  select coalesce(sum(score), 0),
    case when count(*) filter (where score is null) > 0 then 'pending' else 'graded' end
    into v_total, v_status from public.answers where submission_id = p_submission_id;
  update public.submissions set total_score = v_total, status = v_status where id = p_submission_id;
  return jsonb_build_object('exam_id', v_exam, 'submission_id', p_submission_id,
    'question_id', p_question_id, 'score', p_score, 'total_score', v_total, 'status', v_status);
end;
$$;

-- Preserve the existing web-panel contract exactly.
create or replace function public.grade_answer(p_submission_id uuid, p_question_id uuid, p_score numeric)
returns jsonb language sql security definer set search_path = pg_catalog
as $$
  select jsonb_build_object('id', result->'submission_id',
    'total_score', result->'total_score', 'status', result->'status')
  from (select exam_private.grade_for_owner(exam_private.require_teacher(), null,
    p_submission_id, p_question_id, p_score) as result) graded;
$$;

create function public.api_grade_answer(
  p_token text, p_exam_id bigint, p_submission_id uuid, p_question_id uuid, p_score numeric
)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid := exam_private.owner_for_token(p_token);
begin
  if not exists(select 1 from public.api_tokens where owner_id = u
    and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and revoked_at is null and expires_at > now() and 'grade:essay' = any(scopes)) then
    raise exception using errcode = '42501', message = 'This API key does not allow essay grading';
  end if;
  if p_exam_id is null or p_exam_id not between 100000000000 and 999999999999 then
    raise exception using errcode = '22023', message = 'A twelve-digit exam ID is required';
  end if;
  return exam_private.grade_for_owner(u, p_exam_id, p_submission_id, p_question_id, p_score);
end;
$$;

revoke all on function exam_private.grade_for_owner(uuid,bigint,uuid,uuid,numeric)
  from public, anon, authenticated;
revoke all on function public.api_grade_answer(text,bigint,uuid,uuid,numeric)
  from public, anon, authenticated;
grant execute on function public.api_grade_answer(text,bigint,uuid,uuid,numeric)
  to anon, authenticated;

notify pgrst, 'reload schema';
commit;
