# Automation 路径参数异常修复与重跑

## 现场

2026-10-19 本机夜间 v9 搜索的初始流程在第 180 个完成样本发现无效评估：
`automationbench:simple.csat_sheets_slack_alert#1`。

模型请求 `GET https://sheets.googleapis.com/v4/spreadsheets/ss_csat`，
同时把 `spreadsheetId` 放进 query。公开的 `api_search` 已将它标为路径参数。
官方路由将路径值和 query 一起传入函数，触发
`google_sheets_spreadsheets_get() got multiple values for argument 'spreadsheetId'`。

v9 Automation 已停止，原始日志、世界快照保留；该无效结果不进入优化器，不计为有效零分。
MATH 使用独立的 v9 冻结副本继续运行。

## 修复边界

会话只记录已经公开返回的 `api_search` 接口约定。调用方法、完整 URL 模板精确匹配，
且 query 重复声明该接口的路径参数时，返回 `INVALID_TOOL_ARGUMENTS` 工具观察，交给模型自行纠正。
更具体的已公开接口优先；同等具体度有歧义时保持官方调用。

不删除或代改参数，不修改工具实现、世界状态和评分器。
未公开、未知接口及合法参数下的真实内部异常仍按原流程处理，后者使评估无效。

## 验证

- Automation 全部 12 项检查通过，无失败、无跳过。
- 最终接口匹配调整后，另行运行 3 项针对性检查，全部通过。
- 官方同世界回归：原调用复现异常且世界不变；修复后收到参数错误观察且会话健康；
  模型可采用的正确调用 `params={}` 成功返回 `ss_csat`；世界与任务约定不变，官方分数仍为 0。
- 覆盖方法/路径精确匹配、相似接口、跨会话隔离、合法请求下真实内部异常仍无效。

## 实验规则

Automation 以 v10 新协议、新运行目录重新进行全量搜索：200 题、每流程 5 次评估。
不混用 v9 的分数或案例缓存。搜索结束后仅测试冻结的最佳流程：600 题、1 次。
MATH 保持其 v9 搜索和 Test 的同一代码、构建与评分身份。
