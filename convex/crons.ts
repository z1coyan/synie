import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval('durable-io-job-runner', { minutes: 1 }, internal.jobs.runner.tick, {})
crons.interval('product-file-lifecycle', { minutes: 15 }, internal.files.maintenance.scheduleCleanup, {})
crons.interval('product-file-inventory', { hours: 24 }, internal.files.maintenance.scheduleReconciliation, {})
crons.interval('transient-print-dispatch', { minutes: 1 }, internal.platform.printing.jobs.scheduleDue, {})
crons.interval('transient-print-purge', { minutes: 15 }, internal.platform.printing.actions.cleanupExpired, {})

export default crons
