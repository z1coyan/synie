defmodule SynieCore.ConfigTest do
  use ExUnit.Case, async: true

  alias SynieCore.Config

  @database_url "postgres://app:secret@db.example.com:5432/synie"

  describe "repo_config/2 for dev" do
    test "resolves an empty environment to the local Docker database" do
      config = Config.repo_config(:dev, %{})

      assert config[:username] == "postgres"
      assert config[:password] == "postgres"
      assert config[:hostname] == "localhost"
      assert config[:port] == 5440
      assert config[:database] == "synie_dev"
      assert config[:pool_size] == 10
      refute Keyword.has_key?(config, :url)
    end

    test "uses split PG variables when DATABASE_URL is absent" do
      config =
        Config.repo_config(:dev, %{
          "PGUSER" => "synie",
          "PGPASSWORD" => "secret",
          "PGHOST" => "127.0.0.1",
          "PGPORT" => "5441",
          "PGDATABASE" => "custom_dev",
          "POOL_SIZE" => "4"
        })

      assert config == [
               username: "synie",
               password: "secret",
               database: "custom_dev",
               hostname: "127.0.0.1",
               port: 5441,
               pool_size: 4
             ]
    end
  end

  describe "repo_config/2 for test" do
    test "resolves an empty environment to the test database with SQL sandbox" do
      config = Config.repo_config(:test, %{})

      assert config[:database] == "synie_test"
      assert config[:hostname] == "localhost"
      assert config[:port] == 5440
      assert config[:pool] == Ecto.Adapters.SQL.Sandbox
      refute Keyword.has_key?(config, :url)
    end
  end

  describe "repo_config/2 with DATABASE_URL" do
    test "uses DATABASE_URL instead of split PG variables" do
      config =
        Config.repo_config(:dev, %{
          "DATABASE_URL" => @database_url,
          "PGHOST" => "ignored-host",
          "PGPORT" => "not-used",
          "PGDATABASE" => "ignored_database"
        })

      assert config[:url] == @database_url
      assert config[:pool_size] == 10
      refute_split_database_options(config)
    end

    test "keeps SQL sandbox when test uses DATABASE_URL" do
      config = Config.repo_config(:test, %{"DATABASE_URL" => @database_url})

      assert config[:url] == @database_url
      assert config[:pool] == Ecto.Adapters.SQL.Sandbox
      refute_split_database_options(config)
    end
  end

  describe "repo_config/2 integer parsing" do
    test "rejects invalid PGPORT with the variable name and value in the error" do
      error =
        assert_raise RuntimeError, fn ->
          Config.repo_config(:dev, %{"PGPORT" => "not-a-port"})
        end

      assert Exception.message(error) =~ "PGPORT"
      assert Exception.message(error) =~ "not-a-port"
      assert Exception.message(error) =~ ~r/integer/i
    end

    test "rejects invalid POOL_SIZE with the variable name and value in the error" do
      error =
        assert_raise RuntimeError, fn ->
          Config.repo_config(:prod, %{
            "DATABASE_URL" => @database_url,
            "POOL_SIZE" => "too-many"
          })
        end

      assert Exception.message(error) =~ "POOL_SIZE"
      assert Exception.message(error) =~ "too-many"
      assert Exception.message(error) =~ ~r/integer/i
    end
  end

  describe "repo_config/2 for prod" do
    test "requires DATABASE_URL" do
      error =
        assert_raise RuntimeError, fn ->
          Config.repo_config(:prod, %{})
        end

      assert Exception.message(error) =~ "DATABASE_URL"
      assert Exception.message(error) =~ ~r/missing/i
    end

    test "uses DATABASE_URL and parses POOL_SIZE" do
      config =
        Config.repo_config(:prod, %{
          "DATABASE_URL" => @database_url,
          "POOL_SIZE" => "25"
        })

      assert config[:url] == @database_url
      assert config[:pool_size] == 25
      refute_split_database_options(config)
    end
  end

  defp refute_split_database_options(config) do
    refute Keyword.has_key?(config, :username)
    refute Keyword.has_key?(config, :password)
    refute Keyword.has_key?(config, :database)
    refute Keyword.has_key?(config, :hostname)
    refute Keyword.has_key?(config, :port)
  end
end