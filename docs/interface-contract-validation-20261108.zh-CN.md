# 接口协议修复与五数据集小规模验证（2026-11-08）

本轮完成了接口约束和提案字段修复、完整回归，以及五组真实模型小实验。最终代码完整回归 **374/374 通过，0 失败、0 跳过**，类型检查通过。优化器和节点 system 均保持冻结，私有答案排除审计通过。

小实验确认固定基线、真实提案、同轮修复、原生执行器和官方评分可以连通。**没有证据表明正确率提升，也不能据此宣称任意生成的工作流都没有工程问题。** 小实验产生的候选不会替换正式实验的基线或冻结赢家。

## 修复范围

- 提供机器可读的提案 JSON Schema：`rationale` 是非空字符串；提供 `mutation` 时使用 `primaryNodeId`、`auxiliary:[{nodeId,reason}]`；工具声明必须含 `inputSchema`。先检查结构，再进入变更语义检查，避免 `.map is not a function` 一类非定位错误。
- 优化器 user 请求携带 21 个已注册叶节点的原生输入/输出说明、示例与工具参数协议。区分 Context/ACT/OBSERVE 的直接输出和 Infer/Memory/Cache 的实际包装，不猜测或统一移除 `output`。
- 执行前检查已知类型、必填字段、枚举、工具字面量参数和可证明错误的输出路径。动态 JSON、明确的引用默认值和 Subgraph 自定义输出保持开放；动态分支仍需真实执行验证。
- 修复真实实验发现的消息边界问题：原生 Infer 接受的 `unknown[]` 比固定文本模型 HTTP 接口更宽。候选向 `message.content` 传裸字符串数组，会导致 API 422。现在在发送前检查字符串或 `{type:"text",text:string}[]`，返回具体消息字段路径和转换建议。测试确认坏输入不会调用 provider，合法文本块保持原值。
- user 指南明确 `$op:concat` 拼数组；文本拼接使用 HOST 转换；`coalesce` 的参数先绑定，缺失引用须显式 `default`；模型 JSON 须先声明解析；数值工具结果须显式转文本再作为最终输出。执行器没有增加隐式答案归一化。
- 协议/能力说明进入搜索配置身份，旧协议搜索不能直接混入新协议结果。工程错误保留具体 code/path/message/repairHint，同轮修复，不进入有效候选计数。

核心文件：`src/official-agent/proposal-contract.ts`、`native-contracts.ts`、`native-validation.ts`、`tool-contracts.ts`、`search.ts`、`executor.ts` 和 `prompts.ts`。未修改 Ditto npm 实现、评分器、题目划分或模型参数。

## 完整回归和历史回放

完整回归启用真实已安装的 Automation 环境及 subprocess/localhost 访问，耗时 218638 ms。针对性检查 42/42 通过。HumanEval/MBPP 的真实小实验另行经过本机 Docker Python 判分。

历史 24 次提案离线回放：23 次旧无效尝试都可在执行前拦截，原有 1 个有效执行图仍合法，模型/工具/私有判分调用均为 0。该有效图的旧 `mutation` 元数据不符合新显式协议，需要迁移；这不代表整个旧提案原样兼容。

机器记录见 [回归结果](../reports/interface-contract-regression-20261108.json)。本地完整日志位于 `../output/proposal-contract-repair-regression-20261108-final.log`。

## 五数据集真实小实验

实验使用 Ditto 声明式搜索和官方执行器，只沿用 main 的固定 Search 划分及评分。先校验完整固定数据文件，再按 `sha256("42:"+task.id)` 抽题；BFCL 每类选一题。每题 1 次，最多 1 个 interaction 设计轮、3 次提案，目标是基线和 1 个完整新候选。**不是正式 Search 的 5 次重复，也没有读取或运行 Test。**

模型为官方端点的 `deepseek-flash` 别名，不能据此声称与 PR7 使用了同一个具体模型版本。DROP/Automation 用已审查的 manual-seeded 初始化，其余用 baseline。原生库版本仍为 Ditto 0.1.5、Retrieval 0.1.0。

| 数据集 | 基线 | 新候选 | 新候选 ID | 提案过程 |
|---|---:|---:|---|---|
| DROP | 3/3，平均 F1 1.0 | 3/3，平均 F1 1.0 | official-0004 | 1 次元数据拒绝、1 次运行期绑定拒绝后修复 |
| HumanEval | 3/3 | 3/3 | official-0003 | 1 次运行期绑定拒绝后修复 |
| MBPP | 2/3 | 2/3 | official-0002 | 首次提案通过 |
| AutomationBench | 3/3 | 3/3 | official-0003 | 1 次运行期绑定拒绝后修复，连接中断后恢复 |
| BFCL | 3/4 | 原始 2/4；独立补测后描述性均值 3/4 | official-0004 | 2 次结构/方向拒绝后通过；最后一题受主机暂停影响 |

基线 16 个题次都完成有效执行。新候选的 16 个原始题次中有 1 个主机暂停超时，其他 15 个均正常完成；对该题独立补测也正常完成。错误提案仍保留在 history 中，未当成题目错误或有效候选。合计 11 次新提案，5 次成为完整有效候选，另有 3 次 invalid-proposal、3 次 invalid-evaluation。

题次明细（基线 / 新候选）：

- DROP `7671`、`6696`、`6103`：各 1 / 1。
- HumanEval `18`、`15`、`16`：各 1 / 1。
- MBPP `295`：0 / 0；`283`、`101`：各 1 / 1。
- Automation `simple.airtable_find_update`、`simple.weekly_report_sheets_email`、`simple.asana_dark_mode_from_email`：各 1 / 1，评分依据官方最终状态断言。
- BFCL `multi_turn_base_44`：1 / 1；`multi_turn_long_context_106`：0 / 0；`multi_turn_miss_func_161`：1 / 1；`multi_turn_miss_param_167`：基线 1，新候选原始暂停超时 0、独立补测 1。

MBPP 295 正常生成并提取 `sum_div`，Docker 内断言失败，属于解题/任务理解质量问题，没有判分器异常。该公开题目仅写“all divisors”，生成代码包含数本身；不能用更改评分或私有断言来消除失分。

BFCL 长上下文题两种工作流实际都执行了 `get_stock_info → place_order → get_order_details → get_user_tickets → resolve_ticket` 并完成四次 `bfcl_respond`，最终公开完成标志为真；官方错误为 `multi_turn:execution_response_mismatch`。因此不能把它解释成执行器在首次查询后停止。LLM 提案 rationale 曾作出这种错误解释，说明其因果陈述必须与真实轨迹核对。

## 候选组合及探索质量

- DROP：在 `Context LOAD → SAMPLE` 前加入固定 `bounded_arithmetic("100-77.2") → OBSERVE → text → concat`，将探针作为额外 user 信息传给现有 SAMPLE。执行合法且同分，但该算式来自公开示例，并非随题生成的通用计算流程，不能作为泛化改善的证据，不建议采纳。
- HumanEval：`literal_text_find(task.prompt,">>>") → OBSERVE → evidence → concat → 原 SAMPLE`，辅助暴露公开 doctest；保留原任务和 system。三题同分。
- MBPP：`bounded_arithmetic("1+2+3+6") → OBSERVE → text → concat → 原 SAMPLE`。固定算式探针对其他题未必有用，未修复失分。小实验选择器因同分 token 比较将其排前，也不能据此将它推广为正式赢家。
- Automation：在 main 的原决策 SAMPLE 前加入 `taskText → literal_text_find → OBSERVE → evidence → concat`；保留 action Graph 的真实 `ACT → OBSERVE → evidence → tool-history` 和外层决策/执行 Loop。三种真实任务最终状态都通过，但增加的文本查找尚未带来分数收益。
- BFCL：保留 bootstrap、decision、action 三个 Graph 及外层 Loop，将 action 中的证据渲染改为 `ACT → HOST text → history`，OBSERVE 仍接收 ACT 原结果。其新增 `bounded` 入参没有实际实现声称的“有界压缩”；JSON 文本化也不等于压缩。这是探索语义质量不足，不能将其作为新的压缩能力或接口改进成果。

以上五个候选都保留一份 SAMPLE，没有扩充纯 SAMPLE 分支。本轮只覆盖 interaction 设计机会，不能代表所有 Worker、Graph/Loop 分支组合均已验证。静态检查与运行可用性不能替代对工具相关性、实际数据用途及 rationale 真实性的审阅。

## 连接恢复与暂停补测

初次并行和首次串行验证遇到多次 HTTP 599，脱敏桥接诊断为 APIConnectionError/ConnectError。早期结果保留于 `../output/contract-five-small-20261108` 和 `../output/contract-five-small-20261108-serial`。最终验证目录是 `../output/contract-five-small-20261108-final`。

小实验最初只给两次工作流重试；适配器实行累计次数，原样恢复不会重置耗尽额度。恢复时明确提高到 main 已有的五次累计上限，保留失败、有效样本及全部用量；没有删除失败来伪造一次成功。运行脚本记录每次 continuation 的实际驱动脚本 hash 和重试上限。执行器、提示词、依赖或其他源文件变化会拒绝沿用缓存；恢复驱动自身的变动独立记录。

BFCL 新候选最后一题原始记录为 `time-budget-exhausted`，180000 ms 请求上限下记录 elapsed 18420211.9176 ms，与长时间主机暂停一致。原搜索状态和原始 0.5 得分保持原样。使用相同 artifactHash 的冻结候选，在全新官方世界独立补测同一 Search 题，官方评分为 1，14 次 provider 调用、0 失败。补测和其他三题计算出的 0.75 仅为描述性均值，不是改写后的正式搜索成绩。

完整工作流、提案错误、逐题得分及独立补测索引见 [五数据集记录](../reports/official-contract-validation-20261108.json)。原始 candidate、轨迹和私有判分材料留在本机实验目录，没有上传到公共仓库。599 和暂停导致部分调用用量未知，已记录 token 不能当成完整费用，也不支持严格省 token 结论。

## 结论

接口修复、具体错误反馈和同轮修复链路通过了回归与五数据集真实验证。没有观察到新执行器适配故障；无效生成配置仍会出现，并被独立记录和修复。剩余问题主要是搜索提案的语义质量：无关固定探针、忽略实际处理逻辑的“装饰性”变更，以及对轨迹的错误解释。本轮没有测得准确率提升，应保留既有正式基线，不能用小样本同分或自然语言解释代替改进证据。
