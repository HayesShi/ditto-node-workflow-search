# 官方 Agent JSON 整合验收记录

本次工作以 main `9f1c2a1` 为基线。PR9 工程修复先以 `c30a891` 整合；PR7/PR10 按已确认的功能范围接入，没有启用 PR7 完整 JS 搜索作为默认主线，也没有采用 PR10 自动直接 Test 的默认行为。

## 已完成

- 默认 Search/Test CLI 使用官方 AgentDefinition，执行由 Ditto `0.1.5` 的 compileAgent.run 承担。
- 保留父候选 Top-4、30% uniform/70% softmax20、分阶段退步淘汰、同轮工程修复、多 Worker 方向保护和独立预算。
- 候选工具源码/变更说明置于官方 definition 外，工具参与候选哈希与冻结身份；无效提案修复后可重新获得候选资格。
- 原生节点输入检查模型/system/任务边界，Memory/Cache/官方世界按题次隔离，证据呈现包含真实生产节点来源。
- PR7 五个 A 模块及汇总按源码哈希保存为历史 A0；PR10 四张 user 策略卡和 PR7 五数据集提示池成为可选初始化资产。
- 主线新增 BFCL 官方环境适配与 MFlow canonical records 校验；Automation 保留 PR9 严格官方世界评分/恢复；Python/WSL 提取修复按功能合并，并修正 MBPP body-only 补全需保留公开函数签名的回归。
- 提供明确失败的旧图导入器：已将上轮 LOAD→WRITE→SEARCH→SAMPLE 胜出定义导出为官方格式示例，未复用其分数。

## 离线验证

`npm run check`：**343 项，335 通过、0 失败、8 跳过**。跳过项是需要安装真实 Automation 官方环境的可选检查；本次不能据此声称所有真实官方世界均已验收。

检查覆盖：官方 DAG、Subgraph 重用与 Loop；实际 native Memory、Reflect、工具；模型与预算故障保留；模型 JSON 格式零分与错误绑定区分；子图展开后 SAMPLE/依赖预算；元数据修复重提；初始化/源码身份；BFCL 会话、世界快照与同题次重评分；旧执行路径回归。

官方优化提示词审计：通过；跨数据集 optimizer 与节点 system 固定，私有参考排除。使用 **6 次 mock 调用，真实模型调用为 0**。

默认 CLI 完整 DROP Search 预检：固定 **200 题、5 遍协议**，数据哈希验证通过，`providerCreated:false`。这是配置/数据预检，未执行 1,000 题次模型答题，不能报告新的 F1。

## 新包兼容问题的补正

0.1.5 会把应用的 `DITTO_PROVIDER_PYTHON` 当作旧原生配置键拒绝。现仅在加载原生 Runtime 配置时排除明确属于本实验的环境键，保留全局 process.env、合法 ditto.yaml 和真正原生配置的校验；不掩盖任意未知 provider 设置。

新 optimizer 使用独立协议/hash；旧 optimizer 与节点固定系统模板没有被候选修改。所有变化形成新运行身份，不允许旧包/旧定义的缓存继承新成绩。

## 产物与边界

- 接入说明：`docs/official-agent-integration.zh-CN.md`。
- 可读官方示例：`examples/official-agent/drop-memory.agent.json`。
- A0 来源与源码哈希：`examples/legacy-pr7-a0/PROVENANCE.json`。
- 本地日志与快照：`../output/official-json-integration-20261104/` 下的 check.log、prompt-audit-final、drop-preflight-final 和迁移产物。

本次没有启动付费 Search/Test，没有把 PR7 汇总成绩当作独立核验后的新结果。正式阶段仍按已确认计划：先用 Search/合成数据验证 B0，再在 Search 优化并冻结 B1，与独立冻结 A0 分别 Test；主线 Test 只接受对应官方协议的已冻结工件。
