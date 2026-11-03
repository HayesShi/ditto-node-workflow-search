# 官方 Agent JSON 主线接入

本次在 main `9f1c2a1` 上整合 PR9 工程提交，按功能保留 PR7 的 WSL/Python 修复、BFCL 环境桥接、五个原版 A 模块及提示池，并引入 PR10 的可选 user 策略资产。三个 PR 没有整包互相覆盖。

## 默认入口与职责

`npm run search`、`search:drop`、其他主线 Search 及 `test:frozen` 现在通过 `src/official-agent/` 使用官方 `AgentDefinition`，精确依赖 `@codesoul-co/ditto@0.1.5`。真实执行调用包内 `compileAgent(...).run(...)`；Graph 编译、Subgraph 展开、表达式和 Loop 调度由 npm 包负责。

LLM 输出 `{rationale,definition,mutation?,toolArtifacts?}`。只有 `definition` 是纯官方 `agent.json`；候选理由、搜索变更说明、工具源码、哈希和评分身份保留在外层。候选和冻结记录包含工具产物身份，不能在换工具后继承旧分数。

`graphs.main` 必需，main 可以直接解题，也可以参与路由。Subgraph 可选，划分和复用方式由搜索决定。节点依赖是 DAG 依赖，不是条件分支；条件、循环和结束在外层 Loop 声明。

实验程序继续负责固定模型/system、原始任务与答案契约、证据来源标签、预算、父候选选择、逐题评测、工程修复与冻结。官方通用配置能表达某个字段，不等于搜索获得修改模型、权限或评分的资格。新协议有独立 optimizer system 版本和 SHA256，执行节点的固定 system 沿用原版本。

## 可选策略初始化

```powershell
npm run search -- --dataset drop --data-dir ../data/datasets --output-dir runs/drop-official --initialization baseline --offline-only true
npm run search -- --dataset drop --data-dir ../data/datasets --output-dir runs/drop-pr10 --initialization pr10-selected --offline-only true
npm run search -- --dataset bfcl --data-dir DATA_BFCL --output-dir runs/bfcl-official --initialization pr7-guidance --offline-only true
```

这些命令是配置预检，不调用模型。正式运行需明确移除 `--offline-only true`。

- 默认 `baseline`：固定基线，不自动采用高分历史结果。
- `pr10-selected`：导入四数据集已审核的 user 策略文字和首次任务呈现设置；不是原历史工作流的成绩复用。
- `pr7-guidance`：五数据集提示池仅作为优化器 user 侧先验，不把旧 A 环境的能力说明当作当前资源权限。

初始化资产保存来源、内容哈希和快照。续跑使用保存的初始化，身份不同会拒绝；Test 使用已经冻结的图，不用当前策略替换它。Test 仍要求明确的冻结 Search run-dir，不自动从今天的策略资产启动一个未选优 Test。

## 工具与数据处理

`toolArtifacts` 使用已有受限纯 JS 工具契约，经宿主静态检查、inputSchema 校验和隔离执行后注册。官方 JSON 内只声明 ACT.TOOL 调用，不内嵌执行器、SDK、网络或资源配置代码。

对官方表达式没有提供的 JSON 解析、序列化和文本呈现，注册了固定 `HOST.DATA.TRANSFORM` Node。其操作不是通用 JS：`json/text/parse/concat/memory-ids/coalesce/evidence`。证据呈现由宿主附加真实来源；明确的模型 JSON 格式失败计模型零分，非模型数据的绑定或解析问题计工程无效。不能用伪造的 sourceKind 把程序 Bug 改成模型零分。

候选最多一个逻辑 SAMPLE；子图展开后也不能在同一 Graph 内变成多个 SAMPLE。新增必要前后置节点需声明主改动和辅助理由。可修改任意位置的依赖边，按展开后边差异预算校验。图中的纯计算结果必须被数据/控制消费者使用，不能仅靠调度依赖宣称探索成功。

## 旧图迁移与对照

```powershell
npm run migrate:agent -- --input OLD_CANDIDATE.json --output NEW_AGENT.json
```

迁移器支持已验证的单次 DAG 常用操作，输出纯 Agent JSON 和独立候选元信息。不支持的旧 Loop、native 操作或完整 A JavaScript 返回具体诊断，绝不静默删除逻辑。新官方搜索原生支持 Loop/Subgraph，不受导入器的单次 DAG 限制。

PR7 原版五个 A 模块与 results 在 `examples/legacy-pr7-a0/` 按提交和源码哈希保存。它们用于原版 A0 对照，不被自动当作符合新 system/权限合同的官方配置。原 A 的多 SAMPLE、专用 system 和答案后处理不被悄悄带入 B0/B1。

旧自定义 JSON 执行和提示词保留供历史诊断，可使用 `search:json:legacy`；真正复现旧实验仍需原 commit 与原 0.1.1 lock。不能把同一源码在新包下运行的结果冒充旧环境复现。

## MFlow 数据协议与五数据集

| 数据集 | 协议 | Search | Test |
|---|---|---:|---:|
| DROP | aflow-fixed-v1 | 200 | 800 |
| HumanEval | aflow-fixed-v1 | 33 | 131 |
| MBPP | aflow-fixed-v1 | 86 | 341 |
| AutomationBench | automationbench-public-simple-v1 | 200 | 600 |
| BFCL | bfcl-multiturn-family-v1 | 200 | 600 |

既有原始文件按固定字节哈希；BFCL 按 MFlow 发布 `94e5a994...` 的有序 canonical record 哈希，锁定 Gorilla revision。BFCL 以完整会话/题族划分，不重新按回合抽样。Automation 继续使用严格官方环境、世界状态评分和同世界评分恢复。评分/服务故障不能当普通错误答案，也不能重生成后择优。

Search 仍为五遍、Test 三遍，这是本地正式实验政策，不能称为题集名单本身要求。小批量工程验证应另记实验身份，不从 Test 抽题调试。

BFCL 配置：`DITTO_BFCL_ROOT` 指固定官方源码，`DITTO_BFCL_PYTHON` 指官方依赖环境；`--data-dir` 指 MFlow 导出的 BFCL search.jsonl/test.jsonl。Automation 参见原适配器设置。应用自己的 `DITTO_PROVIDER_*`、`DITTO_BFCL_*` 等键与 0.1.5 严格原生环境命名空间隔离；Runtime 仍读取合法的 ditto.yaml 和原生配置，不修改全局 process.env。

## 验收与下一阶段

离线验收包括官方编译器真实执行、Graph/Subgraph/Loop、Memory、原生反思、工具、模型预算、输入绑定失败、JSON 格式零分、来源标签、初始化和私有参考排除，以及 BFCL/Automation mock-world 恢复测试。

`npm run check`、`npm run audit:prompts` 为主要检查。需要真实官方世界的可选测试只有安装相应环境后运行；未运行的真实环境检查须明确记为跳过，不能报告全环境通过。

后续按已确认计划：A0 原版冻结；B0 在 Search/合成样本验证适配；B1 在 Search 优化后冻结；最后两套独立正式 Test。当前整合不复用 PR7 历史分数，也不自动启动付费 Search/Test。
