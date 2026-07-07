import { graphql } from './gql'

export const SayHelloDocument = graphql(`
  query SayHello($name: String!) {
    sayHello(name: $name)
  }
`)

export const LoginDocument = graphql(`
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      token
      user {
        id
        username
        name
      }
    }
  }
`)

export const MeDocument = graphql(`
  query Me {
    me {
      id
      username
      name
    }
  }
`)