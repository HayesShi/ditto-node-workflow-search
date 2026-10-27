# 自动探索改动与复现说明

本改动基于上游 `9da8c83`。原 CLI 默认就是 optimizer-directed search，模型生成完整节点快照，允许插入、删除、替换和重排；不是只允许追加节点的旧树搜索。

## 三个入口

| 入口 | 行为 |
| --- | --- |
| `npm run search:drop` | 保留原节点快照、prepare/solve/refine 执行与全量评测。优化器默认 `baseline`；可显式设 `DITTO_OPTIMIZER_PROFILE=prompt-v2` 或 `feedback-v3`。 |
| `npm run experiment:drop:a` / `experiment:drop` | 新增 A/B 自动探索；A 生成完整 JavaScript 模块，B 生成 JSON Graph/Loop 定义，默认从空历史开始，使用源码英文指南。默认 64 题，可用 PowerShell 参数 `-ValidationSize 200` 扩大。 |
| `powershell -NoProfile -File scripts/run-user-prompts.ps1` | 读取项目 `prompts/` 下两份中文文件，替换打包的先前模型候选中的系统提示词，重新评估后让模型自主生成新候选。默认 A、B 依次运行，200 题，每路最多两个新候选。 |

原 CLI 和 A/B 入口的分数不能直接当成“原版只改提示词”的对照。`prompt-v2` 改原 CLI 的指导；`feedback-v3` 还改变反馈内容。这里未完成保持其他变量完全一致的提示词单因素对照。

## 代码导航

- `scripts/generated-search-prompt.mjs`：证据、机制假设、改善/退步和成本指导；区分工程修复和质量搜索。
- `scripts/generated-workflow-a.mjs`：A 的模块校验、真实 Graph/Loop 构造及节点输入输出记录；VM/语法限制不等于操作系统安全沙箱。
- `scripts/generated-workflow-b.mjs`：B 的绑定算子、Graph、状态、分支和循环执行。
- `scripts/generated-infer-contract.mjs`：使用安装的 Ditto 0.1.1 原生 schema，接入 SAMPLE、TRAJECTORY、DELIBERATE、REFLECT。三种新增操作均可选。
- `scripts/generated-search-feedback.mjs`：按公开字段白名单构造反馈，在共同有效题次上比较改善/退步，筛选有长度上限的真实节点记录。私有答案和评分器内部信息不发送给模型。
- `scripts/generated-small-batch-search.mjs`：优化器请求、候选验证、分阶段执行、费用准入、原始产物与报告；源码英文提示词和外部提示词快照分别记录。
- `src/ditto/runtime.ts`：每次实际 provider 调用前准入，覆盖原生节点内部调用与反思格式修复。
- `src/benchmark/drop.ts`：新增显式验证子集入口；原正式 pinned split 和评分语义保留。
- `scripts/expand-frozen-validation.mjs` / `complete-small-batch-candidate.mjs`：显式冻结扩展及历史重复确认工具；当前搜索每题仅一次，不自动三遍确认。
- `scripts/render-workflow-report.py`：从实际候选结构和评分输出流程图。

## 安装与离线检查

需要 Node 24+、Python 3.11+，使用 `data/README.md` 约定的 pinned 数据。

```powershell
npm.cmd ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-local.txt
$env:DITTO_PROVIDER_PYTHON = "$PWD/.venv/Scripts/python.exe"
npm.cmd run check
npm.cmd run test:generated
.venv/Scripts/python.exe scripts/provider_bridge_test.py
```

`.env.example` 说明模型配置；密钥仅填写在本地 `.env`。数据集、环境、逐题评分与完整轨迹不随 PR 发布。Pillow 用于出图；可用 `DITTO_REPORT_PYTHON` 指定单独的绘图 Python。

## 用中文文件运行

编辑 `prompts/expanded-search-prompts.zh-CN.md` 与 `prompts/candidate-prompts-200.zh-CN.md` 后：

```powershell
powershell -NoProfile -File scripts/run-user-prompts.ps1 -Representation Both
# 单跑 A 或 B：-Representation A / B
```

流程为：保存提示词快照 → 重新评估初始候选 → 模型读取反馈生成候选 → 编译/接口校验与模型修复 → 16/32/64/128/200 阶段验证 → 完整规模选优。工程失败不会当作低质量分数交给优化器。较差候选按预设的同题退步阈值提前停止。每阶段复用本轮先前完成题次；这不是多次重复答题。

每路 `manifest.json` 包含状态、固定配置、预算、提示词标识和用量；`proposals/` 保存请求与模型原始回复；`candidates/` 保存完整产物；`evaluations/` 保存阶段分数和节点轨迹；`best/` 保存完整规模最佳候选。大规模目标提前达标或轮次/预算耗尽时结束。没有新执行时不能保证复现到同一分数。

## 已观察结果及范围

以下是本地历史验证记录，不是本次提交时重新调用 API 产生，也不是独立最终测试成绩。所有 200 题均参与过搜索反馈，800 题测试集未使用。

| 中文提示词实验 | 初始 200 题 F1 | 新候选 |
| --- | ---: | --- |
| A | 91.003% | 第1轮因依赖缺失失败；模型修复后第2轮 200 题 91.174%，增加 REFLECT，候选评测调用由 200 增至 400。 |
| B | 88.410% | 第1轮 64 题 70.923%、第2轮 64 题 79.568%，按退步规则淘汰；最终保留初始候选。 |

本地记录用量 A 为 603 请求/647,525 tokens，B 为 658 请求/469,103 tokens。每题一次；这次从打包的先前模型候选及用户中文提示词开始，而不是从零构造初始拓扑。

更早的英文 A/B 实验与冻结重复记录见 [expanded-infer-search.md](expanded-infer-search.md)。这些实验的起点、提示词和协议应分别解释，不能混成同一结果或归因为仅增加节点能力。
