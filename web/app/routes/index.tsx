import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  return <div>Synie &mdash; loading GraphQL&hellip;</div>
}