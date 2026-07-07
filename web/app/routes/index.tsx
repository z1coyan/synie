import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Card, CardBody, CardHeader, Spinner } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

const HELLO_QUERY = `
  query SayHello($name: String!) {
    sayHello(name: $name)
  }
`

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['hello', 'world'],
    queryFn: () =>
      gqlFetch<{ sayHello: string }>(HELLO_QUERY, { name: 'world' }),
  })

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <Card className="max-w-md w-full">
        <CardHeader className="text-xl font-semibold">Synie</CardHeader>
        <CardBody>
          {isLoading ? (
            <Spinner label="Loading…" />
          ) : error ? (
            <div className="text-danger">
              Error: {error instanceof Error ? error.message : String(error)}
            </div>
          ) : (
            <div>{data?.sayHello}</div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}