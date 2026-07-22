# 本地 .env 加载器(零依赖)。由 config.exs 在非 prod 环境 import。
# 语义:后加载的文件覆盖先加载的;进程里已有的环境变量永不覆盖(shell/CI 优先)。

defmodule SynieDotenv do
  @moduledoc false

  @spec load!([Path.t()]) :: :ok
  def load!(paths) when is_list(paths) do
    file_vars =
      paths
      |> Enum.filter(&File.exists?/1)
      |> Enum.reduce(%{}, fn path, acc -> Map.merge(acc, parse_file(path)) end)

    Enum.each(file_vars, fn {key, value} ->
      if System.get_env(key) in [nil, ""] do
        System.put_env(key, value)
      end
    end)

    :ok
  end

  defp parse_file(path) do
    path
    |> File.stream!()
    |> Stream.map(&String.trim/1)
    |> Stream.reject(&(&1 == "" or String.starts_with?(&1, "#")))
    |> Enum.reduce(%{}, fn line, acc ->
      line = String.replace_prefix(line, "export ", "")

      case String.split(line, "=", parts: 2) do
        [key, value] ->
          key = String.trim(key)

          if key == "" do
            acc
          else
            Map.put(acc, key, value |> String.trim() |> unquote_value())
          end

        _ ->
          acc
      end
    end)
  end

  defp unquote_value(<<?", rest::binary>>),
    do: rest |> String.trim_trailing("\"") |> unescape()

  defp unquote_value(<<?', rest::binary>>),
    do: String.trim_trailing(rest, "'")

  defp unquote_value(value), do: value

  defp unescape(value) do
    value
    |> String.replace("\\n", "\n")
    |> String.replace("\\\"", "\"")
    |> String.replace("\\\\", "\\")
  end
end
