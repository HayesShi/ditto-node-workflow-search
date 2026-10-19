# REFLECT 检查倾向、编排语义与历史失败审计

审计日期：2026-10-20（Asia/Shanghai）。本报告只读取历史数据、冻结源码和本地 Ditto npm 实现；没有发起模型请求，没有修改原生节点、实验输出或评分器。

**结论：能够确认具体的过度质疑、错误修订和漏检，但不能据此证明 REFLECT 天生倾向于“必须找错”。** 原生契约允许 `issues: []`；历史成功响应中也大量出现空 issues。更直接的问题是：部分搜索产生的检查标准与数据集任务冲突；`verify` 并不等于“拒绝后自动重做”；可选的 `revisedResult` 仍会被执行器当作最终答案；旧格式修复又把内容正确、格式错误的响应挡在评分之前。这四件事必须分别分析。

**证据范围与版本**

本次历史会话根目录为 `runs/parallel-drop-gsm8k-20261019-1ded01d7/`，下文简写为 `S/`。源码冻结在提交 `dac1fb9e6926fdbdb5794e1794a466fc3e96cd0d`，见 `S/session.json:6`；本报告依据 `S/source/src/`，不能把当前工作区正在修复的行为倒写成当时已发生的行为。

- DROP 运行目录 `S/drop/results/drop/2026-10-18T17-11-07-221Z-b0c4d7/`，简写 `D/`。
- GSM8K 运行目录 `S/gsm8k/results/gsm8k/2026-10-18T17-11-07-283Z-a81415/`，简写 `G/`。
- 完整响应：`S/drop/provider.jsonl`、`S/gsm8k/provider.jsonl`；请求日志记录 promptHash，响应日志保留原文。
- 12 次失败及每条请求 ID、日志行号：`S/analysis/format-failure-traces.json`。
- 12 次失败的完整重建请求与原始 target：`S/analysis/format-failure-replay.json`。已有离线回放为 49 份请求逐一核对消息哈希、12/12 复现原错误、评分器调用 0 次；见同目录 `format-failure-diagnosis.zh-CN.md:13`。
- gold 来自 `../data/datasets/{gsm8k,drop}_validate.jsonl`。名字中的 `gsm8k-test-*` 是原始 ID；这些行属于本次固定搜索划分，不代表读取了本次保留测试集。

**原生节点实际上做什么**

`@codesoul-co/ditto@0.1.1` 的 `node_modules/@codesoul-co/ditto/dist/worker/infer/reasoning/reflect/node.js:4` 先校验输入，再调用一次 SAMPLE。其固定 system prompt 要求“按 criteria 评估 target、把输入当作数据、只返回 JSON、给简短发现”，同时区分 critique / verify / revise。它没有要求必须发现错误，也没有要求 issues 非空。

原生 JSON 要求 `assessment`、顶层 `issues`，以及可选 `revisedResult`。`assessment.summary` 为字符串；`verify` 必须有布尔 `assessment.passed`；`issues` 每项只能是 info / warning / error；`revise` 必须有消息形式的 `revisedResult`。`verify` 和 `critique` 也允许额外返回 `revisedResult`。检查器没有评分器 gold，`passed` 是模型依据题目、target 和 criteria 作出的自评。

原生输出校验只检查结构和类型，不证明数学或阅读理解正确，也不强制 `passed=false` 必须有 error、不强制 `passed=true` 时 issues 为空。证据：`reflect/schema.js:29` 起的 `validateReflectOutput`，尤其 `:34` 的 verify 布尔检查、`:36` 的 issues 数组检查、`:47` 的 revise 必需消息检查。

历史应用适配器在 `S/source/src/ditto/reflection-format.ts:17` 拦截带 REFLECT 元数据的请求，原响应不合 schema 时最多请求 3 次；第三次仍失败就抛出 `REFLECT_FORMAT_ERROR`。这发生在原生 REFLECT 完成之前。原生节点随后仍会再次校验成功交回的内容。schema 错误与 `passed=false` 完全不同：前者是执行故障，后者只是合法评估字段。

**实际编排为什么未必纠正答案**

`S/source/src/workflow/executor.ts:185` 把前一 Graph 的输出作为 Loop 状态传入；同一 Graph 内，只暴露显式依赖的前置节点输出。`:287` 的 REFLECT 从可见消息中取最后一条作为 target，并把 criteria 转成等权重对象。它没有根据 `passed` 写隐藏的重试、停止或选答案分支。

GSM8K `G/checkpoints/search-002.json:5` 的路径是：

`CONTEXT.LOAD → SAMPLE(sample-1) → REFLECT(verify)`。

该计划 `refine` 的转移直接为 `end`，见同文件 `:82`；输出节点为 `infer-reasoning-reflect-1`，见 `:87`。因此 `passed=false` 不会自动重算，也不会直接让评估失败。执行器 `outputMessage` 优先读取存在的 `revisedResult`；若 verify 没有产生答案消息，`answerFor` 回退到最近的历史答案。证据：`S/source/src/workflow/executor.ts:445`、`:453`。所以准确表述是“无 revisedResult 时保留先前答案”，不能概括为“verify 永远不改答案”。

DROP 计划的区别：

| 候选 | 实际节点 | target / 证据流 |
| --- | --- | --- |
| search-002 | solver + verify | verify 检查 solver；可选 revisedResult 可以替换答案 |
| search-003 | solver + revise | revise 检查 solver；必须给 revisedResult |
| search-004 | solver + verify + revise | 两个 REFLECT 都在 refine，且都是 `dependencies: []`；各自检查原 solver，revise 没有消费 verify 的 verdict/issues |

DROP search-004 不能按文件中节点排列就理解成“先检查，再由改写器吸收检查结果”。同一 Graph 的无依赖节点可以并行执行，provider 日志中的完成顺序也不能代替依赖关系。计划证据：`D/checkpoints/search-004.json:35`、`:57`；执行器可见性证据：`executor.ts:191`。本报告没有把 DROP 两个并行检查器中的“最后一个返回响应”误认成最终输出节点。

**criteria 的具体风险，而非笼统归因给检查器角色**

GSM8K search-002 的三个标准要求重新计算、核对数量和单位、以一个 boxed 答案结尾。它们原则上合理，但模型有时将“核对题意”扩大成额外的欠定性要求，或把已经等价的数量拆分判为错误。详细推导与简洁最终答案也应区分；初始种子要求逐步详细推理，不等于全篇只能很短。

DROP search-002 要求 `Numeric and span answers match the passage exactly`；search-003 又要求候选 unsupported/evasive 时抽取原文；search-004 的 revise 增加 `If the passage does not state the answer ... give the closest exact span`。DROP 本来包含计数、差值、补集等计算，正确答案经常不以独立原文 span 出现。这些规则与任务存在实质冲突。“最终答案不写推导”也不等于“内部不能计算”。

直接局部证据：DROP `4656#1` 问 Baltimore 以多少分击败 Jets，原文比分 10-9，gold=1（数据文件 `:28`）。同一次执行 solver 请求 1055 返回 `1`；verify 请求 1058（`S/drop/provider.jsonl:4246`）承认差值是 1，却明确以 criterion 4 的逐字匹配和 criterion 2 的“no derivation”为由判 false，给出 `revisedResult="10-9"`。该次最终评分从同次 target 的 1 降为 0。这是可以追溯到具体 criteria 的误检/错误修订，不只是角色名称上的推测。

另一个同次例子是 DROP `3023#1`：gold=10.7（数据 `:73`），solver 请求 1146 给 `10.7%`；verify 请求 1148（provider `:4608`）把补集计算误认为必须原文直述，改成无法确定的解释，评分降至 0。种子中的 `|` 多 span 输出与本次最大 F1 评分也可能产生格式损失；这是另一个协议适配问题，不能都算成检查器误报。

**首次原生检查响应的统计**

统计方法是先用完整公开题目与固定种子重建 solver 请求，再收集该题历史实际 solver 响应；按冻结 executor、原生 REFLECT system prompt、实际 criteria 和 context 序列重建首轮检查请求，用 Python 与桥接器相同的 `json.dumps(messages, ensure_ascii=False)` SHA-256 匹配 provider 日志。比较的是该次请求实际检查的 target，没有借用另一个候选/轮次的答案作配对。

下表是 provider 响应级计数：排除追加格式修复消息的请求；原始内容即使 JSON 畸形，只要有明确的 `"passed":true/false` 仍计作该字段的文本表达，不能将其当成原生 schema 已接受的判决。重复搜索评估与工作流重试不是独立题目。

| 数据集 / 模式 | 首次检查响应 | passed=true | passed=false |
| --- | ---: | ---: | ---: |
| DROP verify | 2,001 | 1,624 | 377 |
| DROP revise | 2,000 | 1,406 | 594 |
| DROP 合计 | 4,001 | 3,030 | 971 |
| GSM8K verify | 1,320 | 1,274 | 46 |

DROP 4,001 包含额外工作流重试，不能说有 4,001 道题；搜索划分只有 200 题。GSM8K 是 264 题 × 5 次评估。完整 provider 日志分别有 DROP 9,278 条 request、9,276 条 response；GSM8K 4,351 条 request、4,350 条 response，不能把所有请求都当成检查器调用。

把 GSM8K **同次 target 的最后数值是否符合官方答案**作为代理标签，首轮检查得到：

| target 的最后数值 | passed=true | passed=false | 合计 |
| --- | ---: | ---: | ---: |
| 符合 gold | 1,248 | 37 | 1,285 |
| 不符合 gold | 26 | 9 | 35 |
| 合计 | 1,274 | 46 | 1,320 |

这批记录中，“gold 数值正确但判 false”的比例是 37/1,285=2.88%；“gold 数值错误但判 true”的比例是 26/35=74.29%。这只是当前样本、当前 criteria、当前 target 的代理冲突率，不是检查器通用误报率/漏报率的实验估计。正确最终数值可能伴随错误推理；官方答案也可能依赖约定或有争议。重复题、temperature=0、同一模型担任 solver/checker，以及 schema 失败的选择效应，进一步限制外推。

**合法检查结果实际改变答案多少次**

这里直接读取 `samples.jsonl` 的 `providerDiagnostics[].requestId`，回连该次 solver 响应，使用冻结评分规则比较该次原始 target 与最终 prediction；不是比较两个候选的平均分。GSM8K 只有一个 checker，因此其最终成功响应可明确关联；11 次格式失败不进入这组“合法输出”统计。

- GSM8K search-002：1,309 次合法输出，原 target 数值正确 1,277 次，最终正确 1,266 次；1 次错→对、12 次对→错、1,296 次数值正确性不变。
- 其中 89 次 checker 返回可选 revisedResult，执行器使用该消息；1,220 次没有 revisedResult，回退原答案。65 次最终文本与原 target 不同，文本变化不等于数值变化。
- 合法最终响应 `passed=false` 共 37 次：36 次有 warning/error；1 次只有 info。另有 503 次 `issues: []`。因此不能把“issues 非空”“有 info”与“判不通过”混为同一指标。
- DROP 同次 F1 比较：search-002 的 1,000 次合法输出中提高 94、降低 34、不变 872；search-003 提高 99、降低 70、不变 831；search-004 的 999 次合法输出中提高 100、降低 151、不变 748，另 1 次格式失败。此处没有据此宣称去掉 checker 后重新运行会得到相同分数。

GSM8K 的可核查人工样例：

| 样例 | gold / 同次 target | 检查行为 | 判断边界与证据 |
| --- | --- | --- | --- |
| 428#1 | 26 / 26 | 判 false，称 `18×2+18×1=54` 相对 `36+18=54` 是错误解释，仍保留最终 26 | 54 是中间热狗数量，不是最终答案；两种拆分等价，批评缺乏依据。checker 请求1439，provider行5805；gold 数据行51 |
| 973#1 | 79 / 79 | 判 false，以 USA 州数必须是未知量为由改为符号表达式；最后数值评分变错 | 官方解法使用 USA=50；“题目要求符号表达”并不在原题中。这是协议对齐失败及过度欠定性要求的具体例子。请求1606→1608/1613，provider行6494/6514/6533 |
| 552#1 | 450 / 450 | 判 false，改成900，最终从对变错 | commission 的自然语言可有歧义；900有另一种解释，不能把该例单独证明为纯粹数学无能。正式协议 gold450必须保持。请求1592→1595，provider行6466 |
| 371#1、#5 | 50 / 100 | 均判 false，解释却仍认可100或只要求澄清单位 | target 相对 gold确实错误；不能用作“正确答案被误报”。检查没有抓住基线计数口径 |
| 174#1 | 95 / 95 | 判 true，只给单位表达的 info | 是格式层级失败，不是语义误报。请求1865，provider行7601 |
| 984#4 | 342 / 168 | 判 true | 花坛宽度/间距解释偏离 gold，属于漏检代理样本；不是正确答案被错误拒绝 |

**全部 12 次格式失败逐项核对**

`S/analysis/format-failure-traces.json` 的这些记录不等于所有语义错误，也不是随机样本。表中“首判”来自首个 checker 响应文字；DROP 1775 单独标注 verify 与 revise；“JSON”表示最终 schema 校验报“必须返回合法 JSON 对象”，“层级”表示顶层缺失 issues 数组。所有这些响应都是正常 `stop`，不是输出 token 上限导致的 `length`。

| caseId | gold（数据行） | 同次 solver 最终数值/文本 | 符合 gold | 首判 | solver 请求 → checker 请求 | 最终格式错误；checker 响应日志行 |
| --- | --- | --- | --- | --- | --- | --- |
| drop:1775#3 | 13.7（96） | 13.7% | 是，F1=1 | verify=true；revise=true | 7457 → verify7459；revise7460/7464/7467 | 层级；31764、31767、31781、31798 |
| gsm8k-test-371#1 | 50（199） | 100 | 否 | false | 1775 → 1778/1785/1790 | 多余 `}`；7246、7272、7299 |
| gsm8k-test-174#1 | 95（236） | 95 | 是 | true | 1862 → 1865/1867/1870 | 层级；7601、7614、7627 |
| gsm8k-test-409#2 | 168000（132） | 168000 | 是 | false | 2226 → 2231/2237/2242 | 多余 `}`；9172、9193、9216 |
| gsm8k-test-428#4 | 26（51） | 26 | 是 | false | 3257 → 3261/3268/3274 | 多余 `}`；13566、13593、13615 |
| gsm8k-test-1112#4 | 5（103） | 5 | 是 | false | 3381 → 3385/3389/3394 | 多余 `}`；14083、14104、14124 |
| gsm8k-test-410#4 | 3（118） | 3 | 是 | true | 3414 → 3418/3420/3422 | 层级；14215、14227、14235 |
| gsm8k-test-527#4 | 48（127） | 48 | 是 | false | 3439 → 3444/3449/3453 | 非法 `\]` 转义；14344、14362、14385 |
| gsm8k-test-1200#4 | 8（221） | 8 | 是 | true | 3651 → 3653/3656/3660 | 层级；15219、15237、15251 |
| gsm8k-test-984#4 | 342（231） | 168 | 否 | true | 3676 → 3681/3688/3692 | 层级；15354、15370、15398 |
| gsm8k-test-1176#4 | 2（260） | 2 | 是 | false | 3742 → 3747/3753/3754 | 层级；15630、15636、15641 |
| gsm8k-test-371#5 | 50（199） | 100 | 否 | false | 4199 → 4202/4208/4213 | 多余 `}`；17550、17572、17594 |

表中日志行均来自各自数据集的 provider.jsonl；GSM caseId 的共同前缀为 `gsm8k:`。12 次中 9 次初始答案符合基准，3 次不符合；不能说 12 次都是“答对却失败”。按最终错误分为 6 次层级问题、5 次多余右括号、1 次非法 LaTeX 字符串转义；3 次尝试累计 36 份失败响应。GSM371 两次是 target100对gold50的真实基准错误，DROP1775 和 GSM174 则是清晰的内容正确、接口格式失败。

旧修复请求的第三次消息从原始 `input.messages` 重建，只附加上一次失败响应与同一条反馈，没有累计早先反馈；见 `S/source/src/ditto/reflection-format.ts:41`。历史 12 次中后两次响应均相同，10 次后两次 promptHash 也相同。temperature=0下原样重复与修复消息重复一致；这支持改进格式适配，但不能证明所有内容错误都是由重复提示造成。

**优化器为什么无法自行修补校验器**

优化器的输出空间由 `S/source/src/search/proposer.ts:81` 和 `:102` 限定为一个 allowlist Node JSON；它可搜索 REFLECT 的 mode、criteria、合法依赖，也可选择其他节点类型。它不能提交 TypeScript、任意代码、npm内部函数、provider 或修改命令。`src/workflow/spec.ts:131` 又校验 Node 配置，因此“修改 native schema / 放宽原生 JSON 解析 / 换掉 system prompt”不在其动作空间里。

这与它能否改善任务 criteria 不同：后者确实可搜索，前者属于应用适配或依赖实现。运行时 JSON 格式错误也不是同一件事：同一候选可生成合法节点配置，却在具体题目执行时返回畸形反思输出。

失败后的反馈路径也有限。冻结优化器 `S/source/src/search/optimizer.ts:287` 保存 evaluation-failed 后抛出；不把无效评估当正常分数回传搜索。`S/source/src/search/proposer.ts:178` 的经验压缩只提供少量失败 caseId 和 prediction，不提供私有 gold 或 scorer 错误。这是在防止答案泄露和无效实验污染，代价是不能指望搜索器从一个未进入正常经验的数据面，主动推断并修补底层格式协议。

**本次适配修复能解决什么**

保留原生首轮 prompt、criteria、verdict 与答案语义，只修复可以确定的 JSON 表示问题，并让后续格式反馈累计且明确禁止重新判题，能够处理本报告的接口故障；必须继续经过原生 schema 验证。它不会自动解决 DROP 的 exact-span criterion 冲突、GSM对合理约定的过度质疑、checker漏检或依赖缺失。格式修好后，这些原先被格式错误遮住的语义差异仍应按原评分器原样计分。

历史 v3 记录应保持原样；新的适配策略应标为新协议并使用独立输出目录。离线回放得到的“现在可解析”或“该保存答案按评分器得几分”是工程诊断，不能替代重新完成的正式模型实验成绩。

**已落地的适配修复与离线验证**

新协议为 `mflow-fixed-flash-v4`，适配策略 `reflect-format-v2`。`src/ditto/reflection-normalization.ts` 先处理有确定解释的字段错层、尾部多余右括号、字符串非法反斜杠，随后仍通过未放宽的原生 schema。重复键、字段冲突、缺失判定/答案或歧义语法不猜测、不补造。36 份历史坏响应全部可归一化：18 次提升 issues、15 次删除多余右括号、3 次转义修复；另外 3 份响应同时需要提升 revisedResult，共 39 次操作。

后续模型格式请求保留完整修复历史和编号，同时在代码中核对语义锚点。仅可省略不可用的可选 `suggestedFix:null`；不能改动既有 passed、summary、问题列表、严重程度、答案或元数据。无法建立安全锚点时立即失败，避免“修格式”变成另一次自由判题。审计写入失败不触发额外模型调用。原始文本、规范文本、操作和实际用量均保留；HTTP 故障与正常 length 的处理保持原策略。

使用 `node scripts/replay_reflection_adapter.mjs` 回放原始完整执行路径：12/12 次进入真实私有评分器，评分异常 0 次、模型新增调用 0 次、格式重试 0 次，原始证据哈希不变。结果保存于 `S/analysis/adapter-replay-2026-10-19T16-45-42-055Z-33196/report.json`，包含执行实现哈希及逐节点原文。回放的 12 次中仍有 4 次得 0 分：371 两次仍答100，984仍答168，527被原 checker 改为24（gold48）。适配器没有为了通过而修改这些错误答案，也没有把这组工程子集当正式成绩。

本次未修改原生 checker prompt、搜索生成的 criteria、节点依赖关系或评分规则，也未重启正式搜索。后续若要改 checker，应分别检验 DROP 的计算合法性规则、verify 输出的答案替换权限、verify→revise 的明确依赖，再用同次 target 的配对结果及单独的提示词对照实验衡量；不能只以 issues 数量作为优劣指标。

验证：以已提交源码建立隔离快照，仅叠加本次文件，执行 `npm run check`，类型检查与 116/116 项测试通过；包括本机模拟 HTTP/SSE、原生节点、长度终止、调用故障、评分与保密边界，以及格式重试不能翻转判定或改写答案的保护。工作区其他未提交的 AutomationBench 改动没有进入此快照。
