defmodule SynieCore.Base.AccountTemplates do
  @moduledoc """
  科目表初始化模板:纯数据,供 `Account.:init_from_template` 建账。

  - cas 企业会计准则:6 个会计要素根(资产/负债/共同/权益/成本/损益)+ 一般企业适用一级科目,
    编码取财政部《企业会计准则——应用指南》附录会计科目表;银行/保险/证券等金融专属科目
    (存放中央银行款项、结算备付金、贷款等)已省略。
  - small 小企业会计准则:5 个要素根(无共同类),编码取《小企业会计准则》附录会计科目表。
  - intl 国际通用(精简):5 个要素根(资产/负债/权益/收入/费用,对应 IFRS 五要素),中文名、编码自拟,
    参考通用 chart of accounts 结构精简而成。

  每条:`%{code, name, direction(:debit|:credit), is_group, parent}`。要素根 is_group=true、parent=nil;
  一级科目 is_group=false、parent 指向要素根 code。父条目保证排在子条目之前(根全部在前)。
  备抵类科目(累计折旧、坏账准备、减值准备等)方向与其所属类别相反,已逐条核对。
  """

  @doc "模板清单,key 与 entries/1 参数一致"
  def list do
    [
      %{key: :cas, name: "企业会计准则"},
      %{key: :small, name: "小企业会计准则"},
      %{key: :intl, name: "国际通用(精简)"}
    ]
  end

  defp root(code, name, dir), do: %{code: code, name: name, direction: dir, is_group: true, parent: nil}
  defp acc(code, name, dir, parent), do: %{code: code, name: name, direction: dir, is_group: false, parent: parent}

  @doc "扁平科目条目,parent 引用父条目 code(根为 nil)"
  def entries(:cas) do
    [
      root("1", "资产", :debit),
      root("2", "负债", :credit),
      root("3", "共同", :debit),
      root("4", "所有者权益", :credit),
      root("5", "成本", :debit),
      root("6", "损益", :credit),

      # 资产类
      acc("1001", "库存现金", :debit, "1"),
      acc("1002", "银行存款", :debit, "1"),
      acc("1004", "备用金", :debit, "1"),
      acc("1012", "其他货币资金", :debit, "1"),
      acc("1101", "交易性金融资产", :debit, "1"),
      acc("1121", "应收票据", :debit, "1"),
      acc("1122", "应收账款", :debit, "1"),
      acc("1123", "预付账款", :debit, "1"),
      acc("1131", "应收股利", :debit, "1"),
      acc("1132", "应收利息", :debit, "1"),
      acc("1221", "其他应收款", :debit, "1"),
      acc("1231", "坏账准备", :credit, "1"),
      acc("1321", "代理业务资产", :debit, "1"),
      acc("1401", "材料采购", :debit, "1"),
      acc("1402", "在途物资", :debit, "1"),
      acc("1403", "原材料", :debit, "1"),
      acc("1404", "材料成本差异", :debit, "1"),
      acc("1405", "库存商品", :debit, "1"),
      acc("1406", "发出商品", :debit, "1"),
      acc("1407", "商品进销差价", :credit, "1"),
      acc("1408", "委托加工物资", :debit, "1"),
      acc("1411", "周转材料", :debit, "1"),
      acc("1471", "存货跌价准备", :credit, "1"),
      acc("1501", "持有至到期投资", :debit, "1"),
      acc("1502", "持有至到期投资减值准备", :credit, "1"),
      acc("1503", "可供出售金融资产", :debit, "1"),
      acc("1511", "长期股权投资", :debit, "1"),
      acc("1512", "长期股权投资减值准备", :credit, "1"),
      acc("1521", "投资性房地产", :debit, "1"),
      acc("1531", "长期应收款", :debit, "1"),
      acc("1532", "未实现融资收益", :credit, "1"),
      acc("1601", "固定资产", :debit, "1"),
      acc("1602", "累计折旧", :credit, "1"),
      acc("1603", "固定资产减值准备", :credit, "1"),
      acc("1604", "在建工程", :debit, "1"),
      acc("1605", "工程物资", :debit, "1"),
      acc("1606", "固定资产清理", :debit, "1"),
      acc("1701", "无形资产", :debit, "1"),
      acc("1702", "累计摊销", :credit, "1"),
      acc("1703", "无形资产减值准备", :credit, "1"),
      acc("1711", "商誉", :debit, "1"),
      acc("1801", "长期待摊费用", :debit, "1"),
      acc("1811", "递延所得税资产", :debit, "1"),
      acc("1901", "待处理财产损溢", :debit, "1"),

      # 负债类
      acc("2001", "短期借款", :credit, "2"),
      acc("2101", "交易性金融负债", :credit, "2"),
      acc("2201", "应付票据", :credit, "2"),
      acc("2202", "应付账款", :credit, "2"),
      acc("2203", "预收账款", :credit, "2"),
      acc("2211", "应付职工薪酬", :credit, "2"),
      acc("2221", "应交税费", :credit, "2"),
      acc("2231", "应付利息", :credit, "2"),
      acc("2232", "应付股利", :credit, "2"),
      acc("2241", "其他应付款", :credit, "2"),
      acc("2314", "代理业务负债", :credit, "2"),
      acc("2401", "递延收益", :credit, "2"),
      acc("2501", "长期借款", :credit, "2"),
      acc("2502", "应付债券", :credit, "2"),
      acc("2701", "长期应付款", :credit, "2"),
      acc("2702", "未确认融资费用", :debit, "2"),
      acc("2711", "专项应付款", :credit, "2"),
      acc("2801", "预计负债", :credit, "2"),
      acc("2901", "递延所得税负债", :credit, "2"),

      # 共同类
      acc("3101", "衍生工具", :debit, "3"),
      acc("3201", "套期工具", :debit, "3"),
      acc("3202", "被套期项目", :debit, "3"),

      # 所有者权益类
      acc("4001", "实收资本", :credit, "4"),
      acc("4002", "资本公积", :credit, "4"),
      acc("4101", "盈余公积", :credit, "4"),
      acc("4103", "本年利润", :credit, "4"),
      acc("4104", "利润分配", :credit, "4"),
      acc("4201", "库存股", :debit, "4"),

      # 成本类
      acc("5001", "生产成本", :debit, "5"),
      acc("5101", "制造费用", :debit, "5"),
      acc("5201", "劳务成本", :debit, "5"),
      acc("5301", "研发支出", :debit, "5"),

      # 损益类
      acc("6001", "主营业务收入", :credit, "6"),
      acc("6051", "其他业务收入", :credit, "6"),
      acc("6101", "公允价值变动损益", :credit, "6"),
      acc("6111", "投资收益", :credit, "6"),
      acc("6301", "营业外收入", :credit, "6"),
      acc("6401", "主营业务成本", :debit, "6"),
      acc("6402", "其他业务成本", :debit, "6"),
      acc("6403", "税金及附加", :debit, "6"),
      acc("6601", "销售费用", :debit, "6"),
      acc("6602", "管理费用", :debit, "6"),
      acc("6603", "财务费用", :debit, "6"),
      acc("6701", "资产减值损失", :debit, "6"),
      acc("6711", "营业外支出", :debit, "6"),
      acc("6801", "所得税费用", :debit, "6"),
      acc("6901", "以前年度损益调整", :credit, "6")
    ]
  end

  def entries(:small) do
    [
      root("1", "资产", :debit),
      root("2", "负债", :credit),
      root("3", "所有者权益", :credit),
      root("4", "成本", :debit),
      root("5", "损益", :credit),

      # 资产类
      acc("1001", "库存现金", :debit, "1"),
      acc("1002", "银行存款", :debit, "1"),
      acc("1012", "其他货币资金", :debit, "1"),
      acc("1101", "短期投资", :debit, "1"),
      acc("1121", "应收票据", :debit, "1"),
      acc("1122", "应收账款", :debit, "1"),
      acc("1123", "预付账款", :debit, "1"),
      acc("1131", "应收股利", :debit, "1"),
      acc("1132", "应收利息", :debit, "1"),
      acc("1221", "其他应收款", :debit, "1"),
      acc("1401", "材料采购", :debit, "1"),
      acc("1402", "在途物资", :debit, "1"),
      acc("1403", "原材料", :debit, "1"),
      acc("1404", "材料成本差异", :debit, "1"),
      acc("1405", "库存商品", :debit, "1"),
      acc("1407", "商品进销差价", :credit, "1"),
      acc("1408", "委托加工物资", :debit, "1"),
      acc("1411", "周转材料", :debit, "1"),
      acc("1421", "消耗性生物资产", :debit, "1"),
      acc("1501", "长期债券投资", :debit, "1"),
      acc("1511", "长期股权投资", :debit, "1"),
      acc("1601", "固定资产", :debit, "1"),
      acc("1602", "累计折旧", :credit, "1"),
      acc("1604", "在建工程", :debit, "1"),
      acc("1605", "工程物资", :debit, "1"),
      acc("1606", "固定资产清理", :debit, "1"),
      acc("1621", "生产性生物资产", :debit, "1"),
      acc("1622", "生产性生物资产累计折旧", :credit, "1"),
      acc("1701", "无形资产", :debit, "1"),
      acc("1702", "累计摊销", :credit, "1"),
      acc("1801", "长期待摊费用", :debit, "1"),
      acc("1901", "待处理财产损溢", :debit, "1"),

      # 负债类
      acc("2001", "短期借款", :credit, "2"),
      acc("2201", "应付票据", :credit, "2"),
      acc("2202", "应付账款", :credit, "2"),
      acc("2203", "预收账款", :credit, "2"),
      acc("2211", "应付职工薪酬", :credit, "2"),
      acc("2221", "应交税费", :credit, "2"),
      acc("2231", "应付利息", :credit, "2"),
      acc("2232", "应付利润", :credit, "2"),
      acc("2241", "其他应付款", :credit, "2"),
      acc("2401", "递延收益", :credit, "2"),
      acc("2501", "长期借款", :credit, "2"),
      acc("2701", "长期应付款", :credit, "2"),

      # 所有者权益类
      acc("3001", "实收资本", :credit, "3"),
      acc("3002", "资本公积", :credit, "3"),
      acc("3101", "盈余公积", :credit, "3"),
      acc("3103", "本年利润", :credit, "3"),
      acc("3104", "利润分配", :credit, "3"),

      # 成本类
      acc("4001", "生产成本", :debit, "4"),
      acc("4101", "制造费用", :debit, "4"),
      acc("4301", "研发支出", :debit, "4"),
      acc("4401", "劳务成本", :debit, "4"),

      # 损益类
      acc("5001", "主营业务收入", :credit, "5"),
      acc("5051", "其他业务收入", :credit, "5"),
      acc("5111", "投资收益", :credit, "5"),
      acc("5301", "营业外收入", :credit, "5"),
      acc("5401", "主营业务成本", :debit, "5"),
      acc("5402", "其他业务成本", :debit, "5"),
      acc("5403", "税金及附加", :debit, "5"),
      acc("5601", "销售费用", :debit, "5"),
      acc("5602", "管理费用", :debit, "5"),
      acc("5603", "财务费用", :debit, "5"),
      acc("5711", "营业外支出", :debit, "5"),
      acc("5801", "所得税费用", :debit, "5")
    ]
  end

  def entries(:intl) do
    [
      root("1", "资产", :debit),
      root("2", "负债", :credit),
      root("3", "权益", :credit),
      root("4", "收入", :credit),
      root("5", "费用", :debit),

      # 资产
      acc("1001", "库存现金", :debit, "1"),
      acc("1002", "银行存款", :debit, "1"),
      acc("1101", "应收账款", :debit, "1"),
      acc("1102", "其他应收款", :debit, "1"),
      acc("1103", "预付账款", :debit, "1"),
      acc("1201", "存货", :debit, "1"),
      acc("1202", "原材料", :debit, "1"),
      acc("1301", "固定资产", :debit, "1"),
      acc("1302", "累计折旧", :credit, "1"),
      acc("1401", "无形资产", :debit, "1"),
      acc("1402", "累计摊销", :credit, "1"),
      acc("1501", "长期投资", :debit, "1"),

      # 负债
      acc("2001", "短期借款", :credit, "2"),
      acc("2101", "应付账款", :credit, "2"),
      acc("2102", "其他应付款", :credit, "2"),
      acc("2103", "预收账款", :credit, "2"),
      acc("2201", "应付职工薪酬", :credit, "2"),
      acc("2202", "应交税费", :credit, "2"),
      acc("2301", "长期借款", :credit, "2"),

      # 权益
      acc("3001", "实收资本", :credit, "3"),
      acc("3002", "资本公积", :credit, "3"),
      acc("3101", "盈余公积", :credit, "3"),
      acc("3102", "未分配利润", :credit, "3"),

      # 收入
      acc("4001", "主营业务收入", :credit, "4"),
      acc("4002", "其他业务收入", :credit, "4"),
      acc("4101", "投资收益", :credit, "4"),
      acc("4201", "营业外收入", :credit, "4"),

      # 费用
      acc("5001", "主营业务成本", :debit, "5"),
      acc("5002", "其他业务成本", :debit, "5"),
      acc("5101", "税金及附加", :debit, "5"),
      acc("5201", "销售费用", :debit, "5"),
      acc("5202", "管理费用", :debit, "5"),
      acc("5203", "财务费用", :debit, "5"),
      acc("5301", "营业外支出", :debit, "5"),
      acc("5401", "所得税费用", :debit, "5")
    ]
  end
end
