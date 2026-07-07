import { graphql } from './gql'

export const SayHelloDocument = graphql(`
  query SayHello($name: String!) {
    sayHello(name: $name)
  }
`)