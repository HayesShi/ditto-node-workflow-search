# 单次小批量自动搜索

本文记录先前的64题协议与结果。2026-10-27后续已接入完整 Infer 能力，并扩大到200题，见 [expanded-infer-search.md](expanded-infer-search.md)。

具体解题提示词、节点、绑定、辅助代码、Graph/Loop 控制均由 LLM 生成。宿主提供通用接口、真实运行证据和固定评测规则。work/manual-archive/、runs/native-drop/ 不进入模型请求或候选选择。

## 协议

- generated-drop-small-batch-v1：搜索阶段固定 16 → 32 → 64 题，每题一次。
- 高分候选按用户后续要求冻结为同一批 64 题 × 3 次确认，复用第一遍，只新增第二、三遍；确认结果不用于继续优化或重新挑选候选。
- 验证原始 200 题文件身份，再按预先写定的 seed=20261027 洗牌选择 64 题。A/B 使用相同清单；不按得分或缓存覆盖率选题。
- 首题验证动态接口，成功结果计入后续批量并复用。之后只追加新题。
- 16 题相对完整基线退步超过 15 个百分点、32 题退步超过 8 个百分点才粗筛淘汰；接近者继续。阶段文件记录比较对象。这是成本筛选阈值，不是显著性检验。
- 只有完整 64 题有效 F1 > 0.90 才记作目标达到。小批量结果不宣称为全量 DROP 或独立测试成绩。
- 原正式全量 evaluator 和 pinned 数据校验不变。DROP 的 evaluateSearchSubset 是单独开发入口，禁止用于 test split。

默认每路最多 6 个模型生成候选、500 个模型请求和 150 万已记录 token。预算包含优化器、修复和评估。已完成调用在下一节点派发前结算；到预算不再启动新请求，正在进行的调用仍保存并计费，SDK 重试可能造成少量超额。遇到 HTTP 401/402/403 停止，不把账户失败计作答错。

## 提示词

evidence-hypothesis-v2 要求模型在同一次请求里诊断证据、提出可验证的机制假设、生成完整候选，并说明改善/退步预期和成本。工程修复独立于质量搜索，不因接口报错判定策略无效。实际父候选和已测历史提供依据，目标分数不是已取得的成绩。

反馈由白名单构造：公开题面、预测、得分、共同 caseId 配对差异、成本，以及宿主采集的节点输入输出。包含失分、退步、改善和正确对照；保留循环调用序号。长题面保留开头和问题末尾，截断明示。私有参考答案、私有断言、测试集不进入模型。

## A 与 B

- A v2：完整 JavaScript 模块。校验动态输入、复制 VM 对象为普通 JSON、记录逐次真实输入/原始输出/错误；模型自行编写普通辅助代码。
- B v3：JSON 定义。固定执行器支持绑定、分支、循环、数值比较、长度读取、累积 state 和 stateUpdates。记录与 A 相同的证据，不预设解题结构。
- 共用原生 Workers、官方 deepseek-flash、固定生成参数，以及 locate_public_text、arithmetic、text_contains 通用工具。
- 工具和模型相同，表达能力并非严格等价：A 可用普通 JavaScript，B 受声明式算子限制。A 的 VM 校验不构成操作系统级安全隔离。

## 运行

    npm.cmd run experiment:drop
    npm.cmd run experiment:drop:a

    powershell -NoProfile -File scripts/run-generated-search.ps1 -Representation B -Rounds 6 -Concurrency 3 -MaxCalls 500 -MaxTokens 1500000

此前本地实验曾显式导入 LLM 生成的历史候选作为起点。当前可发布入口默认从空历史开始；只有同时提供 --seed-run 与 --seed-candidate 才读取本地历史缓存，并严格核对数据、模型、生成参数和完整第一遍结果。缓存不随代码发布。使用项目 prompts/ 下中文文件的入口见 [autonomous-workflow-changes.md](autonomous-workflow-changes.md)。

    node --env-file-if-exists=.env scripts/generated-small-batch-search.mjs --representation B --offline-only true

上述离线命令仅固定清单、保存机制快照；显式指定缓存时才重算缓存与出图，不创建 provider。

## 产物

runs/generated-small-batch/drop/ 保存 selection.json 固定清单、mechanism/ 实现快照、proposals/ 模型请求和原始响应、candidates/ 未人工修改的模型候选、checkpoints/ 实际图与父候选、evaluations/ 逐题和节点证据，以及 manifest.json 总账。

workflow-report.png 在每候选完成后更新：单次 F1、题数、实际调用、token、耗时和父子变化。缓存历史逻辑调用与新增调用分开，优化器修复计入总账。失败不显示为有效零分。

原 generated-workflow-search.mjs 和严格五遍恢复模块保留用于旧协议；当前 npm 入口已切换至小批量驱动。

## 冻结确认和补完中断候选

    node --env-file-if-exists=.env scripts/complete-small-batch-candidate.mjs --run-dir <原搜索目录> --candidate <候选ID> --repeats 3 --concurrency 3 --max-calls 280 --report <PNG路径>

确认保存到原目录的 confirmations/<候选ID>/，复制冻结候选、题目清单与原执行机制，单独记录新增消耗。原搜索历史与单次成绩保持不变。默认 repeats=1 时，仅补完同一候选尚未成功的题次；额外预算单独记录，不伪称仍在原搜索预算内。--offline-only true 只检查缓存与身份，不调用 API。

## 2026-10-27 结果

同一批64题，首次用于搜索，后两次只确认冻结候选：

| 方向 | 候选 | 第1次F1 | 第2次F1 | 第3次F1 | 平均F1 |
| --- | --- | ---: | ---: | ---: | ---: |
| A | generated-002 | 91.703% | 90.141% | 90.022% | 90.622% |
| B | generated-004 | 91.926% | 91.926% | 91.926% | 91.926% |

A 搜索目录：runs/generated-small-batch/drop/2026-10-27T10-45-36-347Z-A。
B 搜索目录：runs/generated-small-batch/drop/2026-10-27T10-39-00-236Z-B。

六个新候选均与保存的模型原始响应一致，没有人工修改候选。64题用于搜索，三次重复不等于192道独立题；这些结果尚未证明扩大数据后的泛化表现。
