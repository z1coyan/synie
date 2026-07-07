[
  import_deps: [
    :ash,
    :ash_postgres,
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
