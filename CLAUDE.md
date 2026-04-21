# CLAUDE.md — ServiceTitan Clone Project Conventions

This file is read by every agent at the start of every session. Keep it current.

## Project identity

This is a **standalone** business management system inspired by ServiceTitan. It does not integrate directly with Microsoft Business Central. It may later be connected to an external portal that separately integrates with BC, so the API and data model must stay ERP-agnostic with clean extension points.

## Tech stack

_Populated by the planner during planning phase. Do not modify without evolver approval._

## Required patterns

- Every API endpoint enforces tenant isolation — verify `user.tenant_id` matches resource's `tenant_id` on every read and write.
- Every write operation is wrapped in a transaction.
- Every public function has a JSDoc/docstring with purpose, params, returns, and edge cases.
- Every new migration is reversible (has a down path) and idempotent.
- Every new endpoint has at least: 401 test, 403 test, 400 test, happy-path test, edge-case test.
- Every new background job is idempotent and safe to retry.
- Commit messages follow Conventional Commits: `feat(<phase>): <task-id> <summary>` or `fix(<phase>): ...`, `test(...)`, `chore(evolution): ...`.

## Forbidden patterns

- No `any` types in TypeScript code unless explicitly justified in a comment.
- No secrets, API keys, or credentials in code or committed config.
- No console.log in production paths — use the project logger.
- No direct SQL string concatenation — use the query builder or parameterized queries.
- No commented-out code blocks. Delete or move to documented backlog.
- No `TODO` without a linked task ID.
- No disabling or skipping tests to make a build pass. Ever.

## File and folder layout

_Populated by planner. Enforced by reviewer._

## Multi-tenancy rule

Every tenant-scoped table has a `tenant_id` column. Every query includes `tenant_id` in the WHERE clause. Every API handler extracts `tenant_id` from the authenticated session, not from request input.

## Lessons learned

See `docs/LESSONS.md` — updated by the evolver after each phase. Read it before starting a new phase.

## Escalation

If any agent genuinely cannot proceed (tests can't be made to pass after 3 attempts, environment is broken, criteria are impossible), write to the appropriate `BLOCKED.md` file and stop. Do not fake progress.
