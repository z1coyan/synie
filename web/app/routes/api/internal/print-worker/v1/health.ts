import { createFileRoute } from '@tanstack/react-router'
import { printWorkerReadiness } from '~/server/printing/health'

export const Route = createFileRoute('/api/internal/print-worker/v1/health')({
  server: { handlers: { GET: () => printWorkerReadiness() } },
})
