# BFCL 缺失能力处理与工程验证（2026-11-06）

## 结果与口径

固定 MFlow Search 的四类各选一道，类别内按 sha256(`42:`+题目 ID) 取首题，未使用 Test。模型请求/响应别名为 deepseek-flash，temperature=0；未独立确认其后端版本。本轮是冻结工作流工程验证，没有运行候选优化器。

| 类别 / 题目 | 官方分数 | 有效性 | 模型调用 | tokens | 结果 |
|---|---:|---|---:|---:|---|
| base_44 | 0 | 有效 | 21 | 140,796 | 已写文件，但重复 echo，官方强制停止 |
| long_context_106 | 0 | 有效补测 | 24 | 936,834 | 已买入并查询订单，随后重复查询，官方强制停止 |
| miss_func_161 | 1 | 有效 | 8 | 54,529 | 正确处理缺函数，完成四回合 |
| miss_param_167 | 0 | 有效 | 32 | 193,213 | 正确追问参数并完成前五回合，最后重复查询已取消订单的发票 |

四个有效题次合计 1/4（25%），85 次模型请求、1,325,372 tokens；不外推为 BFCL 全量准确率。之前 miss_func_161 在 12 图执行限制下为 0，本次为 1，但提示词、状态呈现、终止控制和预算均有变化，不能隔离归因为某一个改动。

## 已处理的工程问题

1. **缺失能力边界**：新增固定基线的 user 策略说明：必要函数暂不可用或必填参数不足时，依据已公开证据通过 bfcl_respond 如实回复/追问；提交当前回合并不结束整段会话。读取 bfcl_state 不会解锁新函数。未增加尚未公开的业务函数，未替模型自动回复，节点及优化器 system 未修改。
2. **状态呈现**：bfcl-history 保留最新完整公开快照，追加后续增量观察，并保留完整快照未包含的独立错误。累计快照中的函数 schema、真实调用结果和用户消息不删减。标明实际执行接口及连续重复读取次数，避免模型看不见自己的重复选择。
3. **官方终止控制**：动作图读取真实观察的 complete 标志，在 complete:true 后直接终止 Loop，禁止继续发起 SAMPLE。该标志既可表示正常结束，也可表示官方强制停止，成功与否仍交给官方评分器。
4. **运行限制分层**：不再使用 12 图执行的小验收限制。官方环境仍按固定 MFlow 规则：每回合 bfcl_call 批次计数，`MAXIMUM_STEP_LIMIT=20`，源码条件 `steps>20` 时强制结束，bfcl_respond 后重置。宿主防失控图执行保护为 1024，不能称为官方步数。provider/时间保护单列，触发时判为无效评测。
5. **费用隔离**：小样本脚本支持按类别选题、单题独立 provider 限额；新增预算组同步准入与失败回滚，避免总预算拒绝后单题账本留下并未发生的在途调用。结算回调失败时仍让所有账本记录真实用量。
6. **可搜索说明**：新宿主数据操作说明通过优化器 user 请求提供；system 保持冻结。Graph/Loop 调度仍由 Ditto npm 0.1.5 执行。

## 工作流组合

- main：ACT.TOOL(bfcl_state) → HOST.DATA.TRANSFORM(evidence)，获得初始公开状态。
- decision：INFER.REASONING.SAMPLE → HOST.DATA.TRANSFORM(decision)，由模型选择业务调用、读状态或提交回合。
- action：ACT.TOOL → OBSERVE → evidence → bfcl-history，输出 history 与真实 complete。
- Loop：bootstrap → decision → action → decision；action 的 complete:true 直接结束。没有额外纯 SAMPLE 扩张，也没有宿主自动选择业务动作。

## 逐题情况

### 1. multi_turn_base_44：文件写入，0 分

原题要求找到 annual_report.txt 并仅写入：`Q1: $5000, Q2: $7000, Q3: $6000, Q4: $8000`。

执行：find 找到 `./documents/annual_report.txt` → cd documents → echo 写入内容。随后同样的 echo 重复到总计 19 次，当前回合达到 21 个业务调用批次，官方 forced=true，循环立即停止。

关键区别：官方 echo 实现明确规定“写文件成功返回 None”；这里的 `None` 不是执行器丢失返回值。模型没有据此完成回复，未进入后续回合，属于成功识别/停止决策问题，不能把初次写入说成失败。

### 2. multi_turn_long_context_106：股票与订单，0 分

这是官方模拟投资环境，不是真实证券交易。首轮要求查看 AAPL 表现并以当前市价购买 100 股。

执行：get_stock_info(AAPL) 返回模拟价格 227.16、涨幅 0.17% → place_order(Buy,100) 返回订单 12446、Pending → bfcl_respond 提交首轮。下一轮公开要求核对最新订单是否正确执行。

get_order_details 返回订单参数和 Open 状态，以及很长的公司背景信息。模型没有据实回复“当前仍为 Open”，而是重复同一查询 21 次，触发官方 forced=true。没有把 Open/Pending 解释成已成交。

该题初次单题 300,000 token 保护在 11 次请求后触发，实际已知用量 305,216，该次是无效记录、无可发布分数。只补跑该题，保持同一工作流与评分，独立上限提高至 1,200,000 tokens、80 请求，最终获得上述有效零分。不能把无效记录当作零分或从多次有效结果择优。

### 3. multi_turn_miss_func_161：缺认证函数，1 分

首轮要求用提供的客户端凭据及姓名 Michael Thompson 协助旅行账号认证。当前 schema 没有认证函数；verify_traveler_information 所需生日和护照号也未提供。

- turn 0：一次读状态后，模型通过 bfcl_respond 说明当前缺少认证函数及必要资料，没有编造参数。环境随后公开“已补充函数”的新消息。
- turn 1：读取新 schema 后调用 authenticate_travel，使用已公开参数；收到真实 access token 后提交回复。
- turn 2：用户要求查询新关联卡片余额；调用 get_credit_card_balance，返回 1500.75，并回复。
- turn 3：用户要求计算五笔消费 45.99、78.25、102.50、38.75、92.10 的均值；调用 mean，得到 71.518，并回复。
- 环境返回 complete:true、forced:false，循环直接结束。官方评分 1。

仅一次额外 bfcl_state，不再无限读取。全部新函数和后续问题都由实际回合推进后公开，未预先提供。

### 4. multi_turn_miss_param_167：参数追问与已取消订单发票，0 分

- turn 0：询问 Rivermist 到 Los Angeles、2026-12-15 商务舱价格。并行调用两个机场查询，得到 RMS/LAX，再查票价得到 660 美元，提交回复。
- turn 1：用户要求调整预算但未给金额。模型提交追问，没有编造金额。
- turn 2：用户补充等值 20,000 RMB 的预算及 access token；compute_exchange_rate 得到 2857.14 美元，再 set_budget_limit 成功，提交回复。
- turn 3：按用户公开的新卡片信息 book_flight，获得 booking_id=3426812，提交确认。
- turn 4：按用户要求 cancel_booking，返回 cancel_status:true，提交回复。
- turn 5：用户要求已取消订单的发票；retrieve_invoice 返回 `Booking not found`。模型原样重复调用 21 次，没有依据错误回复，官方强制停止。

这里的错误是官方业务环境返回，执行器完整传给后续决策；不是参数接收或格式转换失败。整段会话计零分，不因前五回合完成就擅自给部分分。

## 验证记录与费用

最终完整串行回归 **350 项，342 通过、0 失败、8 跳过**，跳过的是未在该测试进程配置真实 Automation 环境的可选项。BFCL/native executor 定向测试 18 项通过，覆盖缺函数回复后的 schema 公开、累计 schema 不丢失、错误留存、重复读次数和官方 forced/complete 后不再调用模型。新预算组测试通过。

最初沙箱测试涉及本地子进程时受阻，随后并发回归出现一项既有 Python 5 秒启动超时；没有放宽断言或修改无关提取代码，最终按原断言串行全量复跑通过。

中间调试尝试全部保留，不能只报告最终有效题次费用：

| 本地尝试目录 | 已记录请求 | 已记录 tokens | 状态 |
|---|---:|---:|---|
| bfcl-capability-small-20261106 | 74 | 532,345 | 人工停止重复调用，未完成，不发布成绩 |
| bfcl-capability-feedback-20261106 | 83 | 950,961 | 暴露 complete 后继续调用的问题，停止，不发布成绩 |
| bfcl-capability-final-20261106 | 72 | 693,754 | 三题有效，长上下文一题预算无效 |
| bfcl-capability-long-20261106 | 24 | 936,834 | 长上下文题补测有效 |

合计已记录 **3,113,894 tokens**。被停止进程可能有尚未返回用量的在途请求，故不是可核验账单上限。provider 限额按已返回用量控制下一次请求，可能被当前在途请求越过。

本地最终汇总：`../output/bfcl-capability-report-20261106/summary.json`，四份逐题 Markdown 保留全部实际公开回合和工具顺序。原始 executions、provider、cases、private 世界快照保存在各尝试目录。不会提交数据、环境依赖或凭据。

本次修复范围内未再观察到接口/终止控制异常；三个有效零分集中于模型的重复动作与业务观察理解。四题不足以证明全仓库或全部 BFCL 样本无 Bug，也不足以声称总体分数提升。
