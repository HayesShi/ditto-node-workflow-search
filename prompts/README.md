# 提示词

| 文件 | 用途 |
| --- | --- |
| [expanded-search-prompts.zh-CN.md](expanded-search-prompts.zh-CN.md) | 实际读取的中文优化器提示词、任务要求和 A/B 接口说明。 |
| [candidate-prompts-200.zh-CN.md](candidate-prompts-200.zh-CN.md) | 实际读取的 A/B 初始答题提示词。 |
| [expanded-search-prompts.md](expanded-search-prompts.md) | 英文优化器与接口说明，供对照。 |
| [candidate-prompts-200.md](candidate-prompts-200.md) | 模型生成的英文答题提示词，供对照。 |
| [mflow-search-integrated.en.md](mflow-search-integrated.en.md) | MFlow 英文融合版，改动标黄，尚未接入运行。 |

编辑前两份文件、保存后，在项目目录运行：

```powershell
npm.cmd run experiment:user-prompts
```

程序依次运行 A、B，每路最多生成 2 个新候选，逐级评测至 200 题，每题一次。每路预算为 1,250 次请求、150 万 token；运行会产生 API 费用。

本轮输入保存在 `runs/user-prompts/<timestamp>/inputs/`。修改 Markdown 后需新开运行。初始结构来自 [模型生成的候选](../examples/generated-seeds)，替换提示词后重新评分。

安装和其他入口见 [运行说明](../docs/autonomous-workflow-changes.md)。
