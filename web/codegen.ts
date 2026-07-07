import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: 'http://localhost:4000/graphql',
  documents: ['app/graphql/**/*.ts'],
  generates: {
    'app/graphql/gql/': {
      preset: 'client',
      presetConfig: {
        gqlScalarType: 'string'
      }
    }
  },
  ignoreConfig: true
}

export default config