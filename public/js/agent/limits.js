/**
 * Agent-layer hard limits. Centralized so all caps are discoverable
 * together when an operator needs to tune the surface.
 *
 * - MAX_ACTIVE_JOBS: hard cap on concurrently active (non-settled) jobs.
 *   createJob throws JOB_LIMIT_EXCEEDED once we hit this cap.
 * - MAX_JOBS: total registry cap (settled + active). pruneJobs drops the
 *   oldest *settled* jobs once we exceed this; active jobs are never pruned.
 * - MAX_EXPORT_FRAMES: cap on total frames per video export
 *   (= framerate * duration * loopCount). 18000 = 10 min @ 30 fps.
 *
 * @module agent/limits
 */

export const MAX_ACTIVE_JOBS = 20
export const MAX_JOBS = 50
export const MAX_EXPORT_FRAMES = 18000
