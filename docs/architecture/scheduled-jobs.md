# Distributed Job Scheduler for Farm Operations (Issue #168)

## Overview

Farm operations — irrigation scheduling, fertilizer application, drone survey
missions, and harvest coordination — used to rely on a centralized in-process
cron that was a single point of failure. This module adds a **distributed,
PostgreSQL-backed job scheduler** that runs across many backend replicas. Each
replica claims due work with a lease (so two replicas never run the same job),
guards every operation with a **circuit breaker**, and supports three job
types:

- **Cron** — runs repeatedly on a standard 5-field cron expression.
- **Delayed** — runs once at a specific timestamp.
- **Dependency** — runs only after its declared upstream jobs succeed.

## Components

| File                                   | Responsibility                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/scheduler/scheduled_job_store.ts` | PostgreSQL `scheduled_jobs` store. Claims due jobs under a lease via `SELECT ... FOR UPDATE SKIP LOCKED`. |
| `src/scheduler/cron_parser.ts`         | 5-field cron parser with `*`, ranges, lists, and steps; resolves the next run to within a second.         |
| `src/scheduler/circuit_breaker.ts`     | Sliding-window per-operation breaker.                                                                     |
| `src/scheduler/dependency_resolver.ts` | DAG-based resolution of dependency jobs.                                                                  |
| `src/scheduler/scheduler.ts`           | Poll loop that claims, executes, and book-keeps jobs.                                                     |
| `src/scheduler/types.ts`               | Shared types and constants.                                                                               |

## Durability model

The durable ledger is the `scheduled_jobs` table (created by the
`20260828000001_create_scheduled_jobs` migration):

```
scheduled_jobs(job_id, type, payload, scheduled_at, lease_until, status,
               retry_count, cron_expr, depends_on, ...)
```

Status lifecycle: `pending -> running -> succeeded | failed`.

### Lease-based claiming

Work is claimed with `SELECT ... FOR UPDATE SKIP LOCKED`:

```sql
SELECT * FROM scheduled_jobs
WHERE status = 'pending' AND scheduled_at <= NOW()
ORDER BY scheduled_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1
```

`SKIP LOCKED` means concurrent claimers on other replicas never block on the
same row — they simply race for the next due job. The claiming worker writes a
**30s lease** (`lease_until`, `lease_owner`) and refreshes it **every 10s** so a
long-running irrigation job is never reclaimed out from under itself. If a
worker crashes mid-execution, its un-refreshed lease expires and
`reclaim_expired_scheduled_jobs()` requeues the job for the next replica.

### Retries and alerts

A job is retried up to `maxRetries` (default 3). Once exhausted, it moves to
`failed` and `Scheduler#onExhausted()` fires an alert.

## Circuit breaker

Each operation (e.g. the irrigation-pump API) gets its own breaker. Matching
the issue's spec:

- **Closed** — failures are counted in a sliding 5-minute window.
- **Open** — after 3 failures in the window, calls short-circuit for a 5s
  cooldown.
- **Half-Open** — after the cooldown, exactly one probe call is admitted. A
  success resets the breaker to Closed; a failure trips it back to Open.

## Dependency jobs

When any job completes, `DependencyResolver` finds dependency jobs whose entire
upstream set has succeeded and requeues them. An upstream that fails blocks its
dependents.

## Throughput and precision

- The claim path is a single indexed query plus an UPDATE, sized for the
  project's 10k executions/minute target across five workers.
- Cron resolution walks UTC minute boundaries, keeping sub-minute schedules
  within the required ±1s.

## Operations

See the _Monitoring_ alerts under `monitoring/alerts/` for lease-claim and
backlog alarms. In production the scheduler is started from `index.js`; it is
disabled under `NODE_ENV=test` so the test suite never needs a database.
