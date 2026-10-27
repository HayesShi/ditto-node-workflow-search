# 扩大到 200 题与完整 Infer 接口

2026-10-27，按用户要求，从固定 64 题扩大到原配置的完整 200 道 DROP 验证题。800 道最终测试题未使用。工作流、答题提示词、辅助代码及控制流仍由模型生成，不人工修改候选。

## 本次工程改动

- 优化器提示词 `evidence-hypothesis-v3-full-infer`：以请求中的最大阶段作为达标规模；明确新增三种能力可选，节点数量不等于模型调用次数；不提供人工高分流程模板。
- A `generated-workflow-a-v3-native-infer-input-shapes-and-trace`：生成的完整模块可以调用真实 TRAJECTORY、DELIBERATE、REFLECT；保留原生 Graph/Loop、输入输出记录和模型配置。
- B `generated-b-guide-v4-native-infer`：相同三种操作进入 JSON 定义与固定执行器，绑定字段遵循真实原生输出。
- 共用 `generated-infer-contract.mjs`，直接验证已安装 Ditto 0.1.1 的原生 schema，支持五种 trajectory 策略、四种 deliberate 模式、三种 reflect 模式。保留原生输出含义，不把评价对象当成最终答案。
- `createExperimentRuntime.beforeProviderCall` 在每次真实模型调用前检查预算，涵盖一个节点内的多次推理和反思格式修复；并发占位与已完成 SDK 重试分别计数。内部 SDK 重试和在途 token 仍可能导致完成后的用量高于门控时的数字。
- 默认流程图精简为方案、F1、规模、真实图结构和新增调用/token；细节留在 JSON 记录，`--detailed` 可输出详细图。

所有模型调用维持官方 `deepseek-flash`、temperature=0、thinking disabled 等原配置。主 Ditto 仓库未修改。

## 验证过程

先冻结旧高分候选，复用原64题第一遍，只补136题。各自的输出在原运行目录的 `expanded-validation/<candidate>/`，不会更改历史候选和成绩。

| 旧候选 | 原64题 | 新增136题 | 全200题单次F1 |
| --- | ---: | ---: | ---: |
| A generated-002 | 91.703% | 89.969% | 90.524% |
| B generated-004 | 91.926% | 90.484% | 90.945% |

然后以已完成的200题结果为自动搜索起点。协议 `generated-drop-expanded-v2` 使用同一顺序的 16→32→64→128→200，单题单次，晋级仅补新题。原64题仍是前64个任务。仅完成200题才参与最终候选选择。每路最多两个新候选、750次请求、150万已记录token；优化器、修复、执行均计费。

| 新候选 | 200题单次F1 | 相对旧候选 | 同题改善/退步/持平 |
| --- | ---: | ---: | --- |
| A 第1轮 | 88.674% | -1.850个百分点 | 5 / 11 / 184 |
| A 第2轮 | 91.974% | +1.450个百分点 | 6 / 3 / 191 |
| B 第1轮 | 91.371% | +0.426个百分点 | 8 / 5 / 187 |

模型在这些候选中自主保留原来的节点种类：A 使用 LOAD→SAMPLE→算术工具，Loop 中返回处理后的答案；B 使用两个 SAMPLE。A 改动了答题类型/排名提示、表达式过滤和答案归一化；B 改动了百分比差值、多值问题的输出提示。新增三种操作已接通且通过原生 Worker 本地测试，但本轮候选没有选择它们，因此这些分数不能归因为使用了三种新操作。

新搜索目录：

- `runs/generated-expanded/drop/2026-10-27-native-infer-A`
- `runs/generated-expanded/drop/2026-10-27-native-infer-B`

三份新候选与保存的模型原始响应完全一致。600条第一遍结果离线重新评分，保存分数零差异。200题用于优化反馈和选择，属于验证/搜索成绩；重复执行只检查同题运行波动。

## 已完成的重复确认

按用户此前“高分跑三次”要求，冻结 A第2轮和 B第1轮，复用第一遍，各补两遍。用户随后改为不再重复三遍；收到后检查时两路均已完成，没有在运行的 API 进程，后续默认只运行一遍。

| 优胜候选 | 第1次F1 | 第2次F1 | 第3次F1 | 平均F1 |
| --- | ---: | ---: | ---: | ---: |
| A 第2轮 | 91.974% | 90.486% | 90.507% | 90.989% |
| B 第1轮 | 91.371% | 92.029% | 91.529% | 91.643% |

本次会话新增消耗：旧流程扩大验证408次请求 / 280,562 tokens；A自动搜索402次 / 447,522 tokens；B自动搜索401次 / 273,590 tokens；冻结确认A400次 / 414,414 tokens；冻结确认B800次 / 517,564 tokens。合计 **2,411次请求、1,933,652 tokens**。未换算为金额，未重复计入以前已支付的64题缓存费用。

### 为什么节点图一样而得分不同

节点图只描述操作类型和连线。三个 A 版本的提示词、表达式过滤以及 Loop 返回答案的代码不同。实际案例 `drop:7278`：第1轮与第2轮的 SAMPLE 都答 `Somali Air-force`，工具都算出 `1/2 - 1/3 = 0.16666666666666669`；第1轮把实体答案替换成这个数字，F1为0；第2轮保留实体答案，F1为1。该差异由模型生成的处理代码产生，原始执行记录可核对。

## 可复现入口

```powershell
$env:DITTO_PROVIDER_PYTHON = Join-Path (Get-Location) '.venv/Scripts/python.exe'
npm.cmd run build

# 扩展旧冻结候选：仅补缺失第一遍，--offline-only true 可离线检查。
node --env-file-if-exists=.env scripts/expand-frozen-validation.mjs --run-dir runs/generated-small-batch/drop/2026-10-27T10-45-36-347Z-A --candidate generated-002 --max-calls 150 --concurrency 3

# 新搜索的完整输入和原始输出已保存在 proposals/，一般无需重复花费。
# 如新开搜索，选择新 output 目录，不覆盖既有运行。
node --env-file-if-exists=.env scripts/generated-small-batch-search.mjs --representation A --validation-size 200 --rounds 2 --max-calls 750 --max-tokens 1500000 --seed-run runs/generated-small-batch/drop/2026-10-27T10-45-36-347Z-A/expanded-validation/generated-002 --seed-candidate generated-002 --output runs/generated-expanded/drop/another-A

# 导出当前实际提示词及接口指南，不调用 API。
node scripts/export-generated-prompts.mjs docs/current-generated-prompts.md
```

原64题协议与历史记录保留，见 [small-batch-search.md](small-batch-search.md)。
