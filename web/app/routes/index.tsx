import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@heroui/react'

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center gap-4">
      <Button color="primary">Synie</Button>
    </div>
  )
}