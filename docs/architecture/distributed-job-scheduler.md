# Distributed Job Scheduler with Lease-based Worker Claiming

## Architecture

AgriTrust schedulers now claim work with a Redis-backed lease before dispatching a job to the local worker pool. Each scheduler instance has a stable `schedulerId`; `claimDue()` atomically removes the oldest job from its priority sorted set, writes lease metadata (`leaseOwner`, `leaseExpiresAt`, `lastClaimedAt`) into the job hash, and records the expiry in `jobq:leases`.

The scheduling path remains weighted deficit round-robin across priorities, preserving the existing priority SLO while making claims safe across multiple service replicas. A claimed job is acknowledged only by the lease owner. If a worker cannot start because capacity changed between claim and dispatch, the scheduler releases the lease and requeues the job. Expired leases are reclaimed on each scheduling round so a crashed worker cannot strand work indefinitely.

## Critical-path performance

The claim path is a single Redis Lua operation plus one hash update and is designed for sub-100ms P99 in-region Redis deployments. `job_scheduler_lease_claim_duration_seconds` tracks claim latency with a 100ms SLO bucket.

## Availability and rollout

The design supports blue-green and canary deployments because old pending jobs remain in the existing priority sets and new workers only add lease fields to job payloads. Run one canary scheduler per deployment group, compare lease claim error rate and active lease growth, then scale out the green pool.

## Security considerations

Lease acknowledgements and releases require the claiming `schedulerId`, preventing another scheduler from deleting leased work accidentally. Administrative queue views expose lease timestamps for operators but should stay behind the existing admin authentication boundary.
