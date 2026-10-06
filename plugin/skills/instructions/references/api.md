# Executable API reference

Fixed service origin:
`https://pukanizbahswrupscfmg.supabase.co/functions/v1/exam-api`.

The bundled Python helper requires no third-party packages. It sends the personal
`EXAM_TEACHER_TOKEN` in the Authorization header and refuses HTTP redirects.
The backend verifies ownership and key scope; direct table access is unnecessary.

## Request contract

`create --input PATH` reads a UTF-8 JSON file and POSTs `/exams`.
The root object contains only `title` (1–200 characters) and `questions` (1–100).
Each question has `type`, `prompt` (1–5000 characters), and `points` (greater than
0, at most 100, at most two decimal places). Total points must not exceed 1000.
`mcq` additionally requires exactly four nonempty `options` (at most 1000
characters each) and `correct` (integer 0–3). `essay` must omit both fields.
The encoded request cannot exceed 256 KiB.

Success HTTP 201 returns `id`, `title`, `question_count`, `total_points`, and
`url`. The ID contains twelve digits. The helper verifies that the returned
student URL is exactly `https://mozdbaranarshiya.github.io/exam/id/{id}`.

`results --id ID` GETs `/exams/{id}/results`, where ID is exactly twelve digits.
Success HTTP 200 returns `id`, `title`, `questions`, and `submissions`. Each
submission includes student name, scores, grading status and answers. Pending
essay scores are provisional; `score: null` means not graded yet.

`grade --exam-id ID --submission-id UUID --question-id UUID --score NUMBER`
PATCHes `/exams/{id}/grades` with `submission_id`, `question_id`, and `score`.
The exam ID contains twelve digits; both other IDs are hyphenated UUIDs obtained
from the saved results. Scores may be zero, must not exceed the essay's declared
points (at most 100), and permit at most two decimal places. The helper validates
the general score limits; the database independently verifies the question's
points, essay type, teacher ownership and matching exam/submission/question.
This operation registers or updates an essay grade; MCQs remain automatic.

Success HTTP 200 returns `exam_id`, `submission_id`, `question_id`, `score`,
`total_score`, and `status` (`pending` or `graded`). The helper verifies the IDs
and saved score match the request. `pending` means other essays remain ungraded.
The teacher's token must include `grade:essay`; a newly generated site key has
that scope. Older keys without grading permission must be replaced securely
from the site's «اتصال به ChatGPT» section, without changing database permissions.

## Command output

The only stdout output is a JSON object. Success exits 0; sanitized errors exit
1. Validation, unavailable credentials, invalid API responses, network failure,
401 and 403 are distinct errors. The helper never emits request headers, secret
values, exception traces, or arbitrary error bodies. The timeout is 30 seconds.
Do not automatically retry POST after an uncertain network result.
After an uncertain PATCH result, GET the saved results before repeating the write.

## Security boundaries

The helper's URL is fixed in its source and no CLI option changes it. Redirects
are refused to keep the Authorization header on the intended host. Standard
Python HTTPS certificate verification is retained. Token values may be opaque
secure-proxy placeholders; local token format is deliberately not checked.
An execution environment and personal secure secret are required; a skills-only
plugin does not itself expose an MCP server, Actions tools, or an OAuth login UI.
