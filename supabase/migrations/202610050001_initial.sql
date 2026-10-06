-- Exam service, PostgreSQL 13+ / Supabase. Run once in the SQL editor or via migrations.
-- Passwords are handled by Supabase Auth. Public exam content never includes answer keys.
begin;

create schema if not exists exam_private;
revoke all on schema exam_private from public, anon, authenticated;

create table public.teacher_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,32}$'),
  first_name text not null check (length(btrim(first_name)) between 1 and 100),
  last_name text not null check (length(btrim(last_name)) between 1 and 100),
  phone text not null check (phone ~ '^\+?[0-9]{7,15}$'),
  created_at timestamptz not null default now()
);

create table public.exams (
  id bigint primary key check (id between 100000000000 and 999999999999),
  owner_id uuid not null references public.teacher_profiles(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  created_at timestamptz not null default now()
);
create index exams_owner_created_idx on public.exams(owner_id, created_at desc);

create table public.questions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  exam_id bigint not null references public.exams(id) on delete cascade,
  position integer not null check (position between 1 and 100),
  type text not null check (type in ('mcq', 'essay')),
  prompt text not null check (length(btrim(prompt)) between 1 and 5000),
  points numeric(7,2) not null check (points > 0 and points <= 100),
  options jsonb,
  correct integer,
  unique(exam_id, position),
  unique(id, exam_id),
  check ((type = 'mcq' and options is not null and correct is not null
    and jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4 and correct between 0 and 3)
    or (type = 'essay' and options is null and correct is null))
);

create table public.submissions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  exam_id bigint not null references public.exams(id) on delete cascade,
  first_name text not null check (length(btrim(first_name)) between 1 and 100),
  last_name text not null check (length(btrim(last_name)) between 1 and 100),
  total_score numeric(9,2) not null default 0 check (total_score >= 0),
  max_score numeric(9,2) not null check (max_score > 0 and max_score <= 1000),
  status text not null check (status in ('pending', 'graded')),
  created_at timestamptz not null default now(),
  unique(id, exam_id),
  check (total_score <= max_score)
);
create index submissions_exam_created_idx on public.submissions(exam_id, created_at desc);

create table public.answers (
  submission_id uuid not null,
  exam_id bigint not null,
  question_id uuid not null,
  choice integer check (choice between 0 and 3),
  text text check (length(text) <= 10000),
  score numeric(7,2) check (score >= 0 and score <= 100),
  primary key(submission_id, question_id),
  foreign key(submission_id, exam_id) references public.submissions(id, exam_id) on delete cascade,
  foreign key(question_id, exam_id) references public.questions(id, exam_id) on delete cascade,
  check ((choice is not null and text is null) or (choice is null and text is not null))
);

create table public.api_tokens (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null references public.teacher_profiles(id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  revoked_at timestamptz
);
create index api_tokens_owner_idx on public.api_tokens(owner_id);

alter table public.teacher_profiles enable row level security;
alter table public.exams enable row level security;
alter table public.questions enable row level security;
alter table public.submissions enable row level security;
alter table public.answers enable row level security;
alter table public.api_tokens enable row level security;
revoke all on table public.teacher_profiles, public.exams, public.questions,
  public.submissions, public.answers, public.api_tokens from public, anon, authenticated;
grant select on table public.teacher_profiles to authenticated;
create policy teacher_reads_own_profile on public.teacher_profiles for select to authenticated
  using (id = (select auth.uid()));

create function exam_private.register_teacher()
returns trigger language plpgsql security definer set search_path = pg_catalog
as $$
declare
  m jsonb := new.raw_user_meta_data;
  u text := lower(btrim(m->>'username'));
  f text := btrim(m->>'first_name');
  l text := btrim(m->>'last_name');
  p text := btrim(m->>'phone');
begin
  -- Do not affect accounts belonging to other applications on a shared project.
  if lower(coalesce(new.email, '')) not like '%@teachers.exam.invalid' then return new; end if;
  if jsonb_typeof(m->'username') is distinct from 'string'
    or jsonb_typeof(m->'first_name') is distinct from 'string'
    or jsonb_typeof(m->'last_name') is distinct from 'string'
    or jsonb_typeof(m->'phone') is distinct from 'string'
    or u is null or u !~ '^[a-z0-9_]{3,32}$'
    or lower(new.email) <> u || '@teachers.exam.invalid'
    or f is null or length(f) not between 1 and 100
    or l is null or length(l) not between 1 and 100
    or p is null or p !~ '^\+?[0-9]{7,15}$' then
    raise exception using errcode = '22023', message = 'Invalid teacher registration details';
  end if;
  insert into public.teacher_profiles(id, username, first_name, last_name, phone)
    values (new.id, u, f, l, p);
  return new;
end;
$$;
create trigger register_exam_teacher after insert on auth.users
  for each row execute function exam_private.register_teacher();

create function exam_private.require_teacher()
returns uuid language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid := auth.uid();
begin
  if u is null or not exists(select 1 from public.teacher_profiles where id = u) then
    raise exception using errcode = '28000', message = 'Teacher authentication required';
  end if;
  return u;
end;
$$;

create function exam_private.validate_questions(p_questions jsonb)
returns void language plpgsql set search_path = pg_catalog
as $$
declare q jsonb; o jsonb; n numeric; c numeric; total numeric := 0;
begin
  if jsonb_typeof(p_questions) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Questions must be an array';
  end if;
  if jsonb_array_length(p_questions) not between 1 and 100
    or octet_length(p_questions::text) > 1000000 then
    raise exception using errcode = '22023', message = 'Exam must contain 1 to 100 questions within the size limit';
  end if;
  for q in select value from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(q) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Invalid question';
    end if;
    if not (q ?& array['type', 'prompt', 'points'])
      or exists(select 1 from jsonb_object_keys(q) as k(key) where key not in ('type', 'prompt', 'points', 'options', 'correct'))
      or coalesce(q->>'type', '') not in ('mcq', 'essay')
      or jsonb_typeof(q->'prompt') is distinct from 'string'
      or length(btrim(q->>'prompt')) not between 1 and 5000
      or jsonb_typeof(q->'points') is distinct from 'number' then
      raise exception using errcode = '22023', message = 'Invalid question fields';
    end if;
    n := (q->>'points')::numeric;
    if n <= 0 or n > 100 or trunc(n, 2) <> n then
      raise exception using errcode = '22023', message = 'Question points must be greater than zero, at most 100, with up to two decimal places';
    end if;
    total := total + n;
    if q->>'type' = 'mcq' then
      if jsonb_typeof(q->'options') is distinct from 'array' then
        raise exception using errcode = '22023', message = 'Multiple choice questions require four options';
      end if;
      if jsonb_array_length(q->'options') <> 4 or jsonb_typeof(q->'correct') is distinct from 'number' then
        raise exception using errcode = '22023', message = 'Multiple choice questions require four options and a correct answer';
      end if;
      for o in select value from jsonb_array_elements(q->'options') loop
        if jsonb_typeof(o) is distinct from 'string' or length(btrim(o #>> '{}')) not between 1 and 1000 then
          raise exception using errcode = '22023', message = 'Options must be nonempty strings of at most 1000 characters';
        end if;
      end loop;
      c := (q->>'correct')::numeric;
      if c <> trunc(c) or c not between 0 and 3 then
        raise exception using errcode = '22023', message = 'Correct option must be an integer from zero to three';
      end if;
    elsif coalesce(q->'options', 'null'::jsonb) <> 'null'::jsonb
      or coalesce(q->'correct', 'null'::jsonb) <> 'null'::jsonb then
      raise exception using errcode = '22023', message = 'Essay questions cannot contain options or a correct option';
    end if;
  end loop;
  if total > 1000 then raise exception using errcode = '22023', message = 'Exam points must not exceed 1000'; end if;
end;
$$;

create function exam_private.create_exam_for_owner(p_owner uuid, p_title text, p_questions jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v_id bigint; q jsonb; i integer := 0; attempts integer := 0; v_created timestamptz; v_total numeric := 0;
begin
  if p_owner is null or not exists(select 1 from public.teacher_profiles where id = p_owner) then
    raise exception using errcode = '28000', message = 'Teacher authentication required';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Title must contain 1 to 200 characters';
  end if;
  perform exam_private.validate_questions(p_questions);
  loop
    -- Twelve decimal digits keep links compact and fit safely in JavaScript integers.
    v_id := 100000000000 + (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint % 900000000000);
    begin
      insert into public.exams(id, owner_id, title) values (v_id, p_owner, btrim(p_title)) returning created_at into v_created;
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 10 then raise exception 'Could not allocate an exam ID'; end if;
    end;
  end loop;
  for q in select value from jsonb_array_elements(p_questions) loop
    i := i + 1;
    v_total := v_total + (q->>'points')::numeric;
    insert into public.questions(exam_id, position, type, prompt, points, options, correct)
      values (v_id, i, q->>'type', btrim(q->>'prompt'), (q->>'points')::numeric,
        case when q->>'type' = 'mcq' then q->'options' end,
        case when q->>'type' = 'mcq' then (q->>'correct')::numeric::integer end);
  end loop;
  return jsonb_build_object('id', v_id, 'title', btrim(p_title), 'created_at', v_created,
    'question_count', i, 'total_points', v_total);
end;
$$;

create function public.create_exam(p_title text, p_questions jsonb)
returns jsonb language sql security definer set search_path = pg_catalog
as $$ select exam_private.create_exam_for_owner(exam_private.require_teacher(), p_title, p_questions); $$;

create function public.list_exams()
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid := exam_private.require_teacher(); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'created_at', e.created_at,
    'question_count', (select count(*) from public.questions q where q.exam_id = e.id),
    'total_points', (select sum(q.points) from public.questions q where q.exam_id = e.id),
    'submission_count', (select count(*) from public.submissions s where s.exam_id = e.id)) order by e.created_at desc, e.id), '[]'::jsonb)
    into result from public.exams e where e.owner_id = u;
  return result;
end;
$$;

create function public.get_exam(p_exam_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare result jsonb;
begin
  select jsonb_build_object('id', e.id, 'title', e.title,
    'questions', (select jsonb_agg(jsonb_build_object('id', q.id, 'type', q.type, 'prompt', q.prompt,
      'points', q.points, 'options', q.options) order by q.position) from public.questions q where q.exam_id = e.id))
    into result from public.exams e where e.id = p_exam_id;
  if result is null then raise exception using errcode = 'P0002', message = 'Exam not found'; end if;
  return result;
end;
$$;

create function public.submit_exam(p_exam_id bigint, p_first_name text, p_last_name text, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v_question record; a jsonb; v_id uuid; v_max numeric; v_choice numeric; v_score numeric;
  v_count integer; v_pending boolean;
begin
  if p_first_name is null or length(btrim(p_first_name)) not between 1 and 100
    or p_last_name is null or length(btrim(p_last_name)) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Student first and last name are required, up to 100 characters each';
  end if;
  if jsonb_typeof(p_answers) is distinct from 'object' or octet_length(p_answers::text) > 1000000 then
    raise exception using errcode = '22023', message = 'Answers must be an object within the size limit';
  end if;
  select count(*), sum(points), coalesce(bool_or(type = 'essay'), false) into v_count, v_max, v_pending
    from public.questions where exam_id = p_exam_id;
  if v_count = 0 then raise exception using errcode = 'P0002', message = 'Exam not found'; end if;
  if (select count(*) from jsonb_object_keys(p_answers)) <> v_count
    or exists(select 1 from jsonb_object_keys(p_answers) k(key)
      where not exists(select 1 from public.questions q where q.exam_id = p_exam_id and q.id::text = k.key)) then
    raise exception using errcode = '22023', message = 'Provide one answer for every question, without unknown questions';
  end if;
  insert into public.submissions(exam_id, first_name, last_name, max_score, status)
    values (p_exam_id, btrim(p_first_name), btrim(p_last_name), v_max, case when v_pending then 'pending' else 'graded' end)
    returning id into v_id;
  for v_question in select * from public.questions where exam_id = p_exam_id order by position loop
    a := p_answers->v_question.id::text;
    if jsonb_typeof(a) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Invalid answer object';
    end if;
    if v_question.type = 'mcq' then
      if jsonb_typeof(a->'choice') is distinct from 'number'
        or (select count(*) from jsonb_object_keys(a)) <> 1 then
        raise exception using errcode = '22023', message = 'Multiple choice answers require only a choice';
      end if;
      v_choice := (a->>'choice')::numeric;
      if v_choice <> trunc(v_choice) or v_choice not between 0 and 3 then
        raise exception using errcode = '22023', message = 'Choice must be an integer from zero to three';
      end if;
      v_score := case when v_choice::integer = v_question.correct then v_question.points else 0 end;
      insert into public.answers(submission_id, exam_id, question_id, choice, score)
        values (v_id, p_exam_id, v_question.id, v_choice::integer, v_score);
    else
      if jsonb_typeof(a->'text') is distinct from 'string' or length(btrim(a->>'text')) not between 1 and 10000
        or (select count(*) from jsonb_object_keys(a)) <> 1 then
        raise exception using errcode = '22023', message = 'Essay answers require nonempty text of at most 10000 characters';
      end if;
      insert into public.answers(submission_id, exam_id, question_id, text, score)
        values (v_id, p_exam_id, v_question.id, btrim(a->>'text'), null);
    end if;
  end loop;
  update public.submissions set total_score = (select coalesce(sum(score), 0) from public.answers where submission_id = v_id) where id = v_id;
  -- A receipt deliberately contains neither marks nor correct answers.
  return jsonb_build_object('id', v_id, 'exam_id', p_exam_id, 'status', 'received');
end;
$$;

create function exam_private.results_for_owner(p_owner uuid, p_exam_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare result jsonb;
begin
  if not exists(select 1 from public.exams where id = p_exam_id and owner_id = p_owner) then
    raise exception using errcode = '42501', message = 'Exam unavailable';
  end if;
  select jsonb_build_object('id', e.id, 'title', e.title,
    'questions', (select jsonb_agg(jsonb_build_object('id', q.id, 'type', q.type, 'prompt', q.prompt,
      'points', q.points, 'options', q.options, 'correct', q.correct) order by q.position) from public.questions q where q.exam_id = e.id),
    'submissions', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name,
      'total_score', s.total_score, 'max_score', s.max_score, 'status', s.status, 'created_at', s.created_at,
      'answers', (select jsonb_agg(jsonb_build_object('question_id', q.id, 'prompt', q.prompt, 'type', q.type,
        'points', q.points, 'options', q.options, 'choice', a.choice, 'text', a.text, 'score', a.score, 'correct', q.correct)
        order by q.position) from public.answers a join public.questions q on q.id = a.question_id where a.submission_id = s.id))
      order by s.created_at desc, s.id), '[]'::jsonb) from public.submissions s where s.exam_id = e.id))
    into result from public.exams e where e.id = p_exam_id;
  return result;
end;
$$;

create function public.get_results(p_exam_id bigint)
returns jsonb language sql security definer set search_path = pg_catalog
as $$ select exam_private.results_for_owner(exam_private.require_teacher(), p_exam_id); $$;

create function public.grade_answer(p_submission_id uuid, p_question_id uuid, p_score numeric)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid := exam_private.require_teacher(); v_exam bigint; v_points numeric; v_type text;
  v_score numeric; v_status text;
begin
  -- Lock the submission so concurrent graders cannot overwrite its aggregate score.
  select s.exam_id into v_exam from public.submissions s join public.exams e on e.id = s.exam_id
    where s.id = p_submission_id and e.owner_id = u for update of s;
  if v_exam is null then raise exception using errcode = '42501', message = 'Submission unavailable'; end if;
  select q.points, q.type into v_points, v_type from public.questions q join public.answers a on a.question_id = q.id
    where q.id = p_question_id and q.exam_id = v_exam and a.submission_id = p_submission_id;
  if v_points is null or v_type <> 'essay' then
    raise exception using errcode = '22023', message = 'Only an essay answer in this submission can be graded';
  end if;
  if p_score is null or p_score < 0 or p_score > v_points or trunc(p_score, 2) <> p_score or p_score::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'Score must be between zero and the question points, with up to two decimal places';
  end if;
  update public.answers set score = p_score where submission_id = p_submission_id and question_id = p_question_id;
  select coalesce(sum(score), 0), case when count(*) filter (where score is null) > 0 then 'pending' else 'graded' end
    into v_score, v_status from public.answers where submission_id = p_submission_id;
  update public.submissions set total_score = v_score, status = v_status where id = p_submission_id;
  return jsonb_build_object('id', p_submission_id, 'total_score', v_score, 'status', v_status);
end;
$$;

create function public.issue_api_token()
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid := exam_private.require_teacher(); v_token text; v_expires timestamptz;
begin
  -- Serialize issuance to enforce the active key limit under concurrent requests.
  perform 1 from public.teacher_profiles where id = u for update;
  if (select count(*) from public.api_tokens where owner_id = u and revoked_at is null and expires_at > now()) >= 5 then
    raise exception using errcode = '22023', message = 'At most five active API keys are allowed; revoke keys first';
  end if;
  v_token := 'exam_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.api_tokens(owner_id, token_hash)
    values (u, encode(sha256(convert_to(v_token, 'UTF8')), 'hex')) returning expires_at into v_expires;
  return jsonb_build_object('token', v_token, 'expires_at', v_expires);
end;
$$;

create function public.revoke_api_tokens()
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid := exam_private.require_teacher(); n integer;
begin
  perform 1 from public.teacher_profiles where id = u for update;
  update public.api_tokens set revoked_at = now() where owner_id = u and revoked_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('revoked', n);
end;
$$;

create function exam_private.owner_for_token(p_token text)
returns uuid language plpgsql security definer set search_path = pg_catalog
as $$
declare u uuid;
begin
  if p_token is null or p_token !~ '^exam_[a-f0-9]{96}$' then
    raise exception using errcode = '28000', message = 'Invalid or expired API key';
  end if;
  select owner_id into u from public.api_tokens
    where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and revoked_at is null and expires_at > now();
  if u is null then raise exception using errcode = '28000', message = 'Invalid or expired API key'; end if;
  return u;
end;
$$;

create function public.api_create_exam(p_token text, p_title text, p_questions jsonb)
returns jsonb language sql security definer set search_path = pg_catalog
as $$ select exam_private.create_exam_for_owner(exam_private.owner_for_token(p_token), p_title, p_questions); $$;

create function public.api_results(p_token text, p_exam_id bigint)
returns jsonb language sql security definer set search_path = pg_catalog
as $$ select exam_private.results_for_owner(exam_private.owner_for_token(p_token), p_exam_id); $$;

-- PostgreSQL grants PUBLIC function execution by default. Remove it explicitly.
revoke all on all functions in schema exam_private from public, anon, authenticated;
revoke all on function public.create_exam(text,jsonb), public.list_exams(), public.get_exam(bigint),
  public.submit_exam(bigint,text,text,jsonb), public.get_results(bigint), public.grade_answer(uuid,uuid,numeric),
  public.issue_api_token(), public.revoke_api_tokens(), public.api_create_exam(text,text,jsonb),
  public.api_results(text,bigint) from public, anon, authenticated;
grant execute on function public.create_exam(text,jsonb), public.list_exams(), public.get_results(bigint),
  public.grade_answer(uuid,uuid,numeric), public.issue_api_token(), public.revoke_api_tokens() to authenticated;
grant execute on function public.get_exam(bigint), public.submit_exam(bigint,text,text,jsonb),
  public.api_create_exam(text,text,jsonb), public.api_results(text,bigint) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
