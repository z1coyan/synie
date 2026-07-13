# 导入模板的日期/时间格式预设(用户拍板:枚举下拉,不做自由文本)。
# value 是语义 slug,description 存格式串本体——下拉/筛选显示、导入轮解析分发都认它;
# text 存储,扩格式=加值,无迁移。
defmodule SynieCore.Acc.BankImportTemplate.DatetimeFormat do
  @moduledoc "日期时间列格式(时间单列模式)。"

  use Ash.Type.Enum,
    values: [
      ymd_dash_hms: "YYYY-MM-DD HH:mm:ss",
      ymd_dash_hm: "YYYY-MM-DD HH:mm",
      ymd_slash_hms: "YYYY/MM/DD HH:mm:ss",
      ymd_slash_hm: "YYYY/MM/DD HH:mm",
      compact_space: "YYYYMMDD HHmmss",
      compact: "YYYYMMDDHHmmss",
      iso_t: "YYYY-MM-DDTHH:mm:ss",
      cn_hms: "YYYY年MM月DD日 HH:mm:ss",
      mdy_slash_hms: "MM/DD/YYYY HH:mm:ss",
      dmy_slash_hms: "DD/MM/YYYY HH:mm:ss"
    ]

  def graphql_type(_), do: :acc_bank_datetime_format
end

defmodule SynieCore.Acc.BankImportTemplate.DateFormat do
  @moduledoc "日期列格式(日期/时间双列模式)。"

  use Ash.Type.Enum,
    values: [
      ymd_dash: "YYYY-MM-DD",
      ymd_slash: "YYYY/MM/DD",
      ymd_compact: "YYYYMMDD",
      ymd_dot: "YYYY.MM.DD",
      ymd_cn: "YYYY年MM月DD日",
      mdy_slash: "MM/DD/YYYY",
      dmy_slash: "DD/MM/YYYY",
      dmy_dash: "DD-MM-YYYY"
    ]

  def graphql_type(_), do: :acc_bank_date_format
end

defmodule SynieCore.Acc.BankImportTemplate.TimeFormat do
  @moduledoc "时间列格式(日期/时间双列模式,时间列可省,缺省 00:00:00)。"

  use Ash.Type.Enum,
    values: [
      hms: "HH:mm:ss",
      hm: "HH:mm",
      hms_compact: "HHmmss",
      hms_cn: "HH时mm分ss秒"
    ]

  def graphql_type(_), do: :acc_bank_time_format
end
