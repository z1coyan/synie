[
  import_deps: [
    :ash,
    :ash_postgres,
    :ash_graphql,
    :ash_authentication,
    :ash_authentication_phoenix,
    :ecto,
    :ecto_sql
  ],
  subdirectories: ["apps/*/priv/*/migrations"],
  inputs: [
    "*.{ex,exs}",
    "{config,lib,test}/**/*.{ex,exs}",
    "apps/*/{config,lib,test}/**/*.{ex,exs}"
  ]
]
