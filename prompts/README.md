# 提示词文件

| 文件 | 输入给谁、用途 |
| --- | --- |
| [expanded-search-prompts.zh-CN.md](expanded-search-prompts.zh-CN.md) | 中文优化器系统提示词、任务要求、工具和 A/B 接口说明；准备脚本从这里提取。 |
| [candidate-prompts-200.zh-CN.md](candidate-prompts-200.zh-CN.md) | A 的 solve、B 的 extract-evidence/draft-answer 初始答题提示词；准备脚本只替换对应节点的系统消息。 |
| [expanded-search-prompts.md](expanded-search-prompts.md) | 英文优化器及接口指南的保存版本，供阅读比较。默认源码常量另见 scripts/generated-search-prompt.mjs 等。 |
| [candidate-prompts-200.md](candidate-prompts-200.md) | 原模型生成的英文答题提示词，供阅读比较。 |
| [mflow-search-integrated.en.md](mflow-search-integrated.en.md) | 将英文改进融入原 MFlow 搜索提示词后的文档；新增、改写段落用 `<mark>` 标黄。它是待集成文档，不由当前 A/B 入口自动读取。 |

修改中文前两份文件后保存，在项目 PowerShell 运行：

```powershell
powershell -NoProfile -File scripts/run-user-prompts.ps1 -Representation Both
```

该命令会调用付费模型。A/B 各最多生成两个新候选，默认逐级扩至 200 题、每题一次；初始候选也重新评分。每路上限 1,250 次请求、150 万已记录 token。限额是请求准入门控，SDK 内部重试及在途工作可能超过门控时的数量。

准备脚本将提示词快照和初始候选写入一个新的 `runs/user-prompts/<timestamp>/inputs/`。本轮开始后再编辑 Markdown 不会改变已冻结的快照，应新开运行。初始结构来自 [先前模型生成的候选](../examples/generated-seeds)，不包含旧得分、题目答案或缓存。

从空历史生成全新工作流、使用源码中的英文指导时，运行 `scripts/generated-small-batch-search.mjs`，不要传入 `--seed-proposal` 或 `--seed-run`。具体步骤和各入口区别见 [改动说明](../docs/autonomous-workflow-changes.md)。
