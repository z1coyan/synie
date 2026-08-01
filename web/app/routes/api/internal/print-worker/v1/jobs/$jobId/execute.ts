import { createFileRoute } from '@tanstack/react-router'
import { handlePrintWorkerExecute } from '~/server/printing/worker'

export const Route = createFileRoute('/api/internal/print-worker/v1/jobs/$jobId/execute')({
  server: {
    handlers: {
      POST: ({ request, params }) => handlePrintWorkerExecute(request, params.jobId),
    },
  },
})
