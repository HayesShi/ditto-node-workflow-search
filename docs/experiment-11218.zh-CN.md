# 11218：单节点变更与共享资源验证

用户确认：新增、删除、功能修改合计最多一个节点。替换保留节点 ID。必要的依赖边和引用接线单独计算，沿用 max(12, 4*N) 依赖边预算；反向边计两次。不再允许同次增加伴随功能节点，mutation.auxiliary 必须为空。

功能差分比较节点 type、非接线 input 内容及 require；dependsOn 和引用接线不算第二个功能节点。按用户最新确认，新增或修改 Infer user 消息、证据提示前缀、消息内缺省文本及 objective 不属于节点功能修改，单独记录为 promptChanges。操作类型、工具入参、原生推理策略和控制约束仍属于功能修改。system 模板继续冻结。原有原生 schema、输入类型、固定 host model/generation、system 权限和数据消费校验保持有效。Graph/Loop 定义与全局用户策略仍按原授权搜索。

所有搜索方向共享全局调用与 Token 预算，不再为检索、原生推理、交互或 Memory/Cache 分配独立预算。四方向探索轮转保留。旧实验的预算与快照不改写；旧检查点不得直接用新协议续跑。

错误反馈包含 allowed、actual、added、removed、modified、wiringOnly，以及恢复其他功能节点、保留替换 ID 的修复建议。边差分另外列出具体边。

结果根目录：`output/11218`（工作区根目录）。预检包括完整离线回归、冻结提示词审计和历史提案重放。随后仅在固定 Search 划分中抽取 DROP 16 题、Automation 4 题，各重复一次，基线加最多四个新有效候选、最多十二轮设计、每轮三次提案/修复。Automation 使用已验证的 layered v10 初始工作流。小实验不触碰 Test，不作为正式泛化成绩。

模型和评分器沿用原配置；不修改数据答案、评分逻辑或 Worker system 提示词。优化器 system 同样保持冻结，新的变更限额由 user 请求 immutableProtocol 提交。

后续口径修订为 one-functional-node-prompts-separate-v3；旧 v2 成绩保留在工作区 output/11218/revisions/v2，新验证单独保存在 output/11218/prompt-free-v3，禁止混用两版候选池。

## 历史成绩的比较口径

正式候选 official-0039 使用 CONTEXT.LOAD → query → CONTEXT.SELECT → evidence → evidenceText → TRAJECTORY(long-cot, maxSteps=4)，Search 为固定 200 题×5，F1 91.7228%；冻结后 Test 为 800 题×3，F1 92.4250%。当时允许一次主改动带必要伴随节点、最多五个旧节点 input 编辑；正式搜索实际得到七个完整候选并因 100 轮设计预算截断，未收敛。

11218 v2 为固定 Search 中另抽 16 题×1，最佳为 LOAD → RETRIEVAL.SEARCH → SAMPLE，F1 89.5109%，其基线 77.6974%。按这同样 16 题重算旧 official-0039 的历史五次平均为 89.5192%，单次 85.7692%—92.0192%；两者平均差仅约 0.0084 个百分点。它们仍有重复次数、执行时间和候选结构的差异，不能据此推断搜索规则的因果影响。模型别名、temperature/maxTokens、optimizer system 和 Node system 哈希两版一致；实际后端版本未独立核实。

## 2026-11-13 正式搜索与 Test

运行入口 scripts/run_11218_overnight.ps1，独立数据集进程、DROP 并发 16、Automation 并发 24。固定 Search 200题×5，冻结后 Test 分别为 800题×3、600题×3。正常停止以 Top-3 连续五次有效评测不变或20个完整候选预算为准，不再以100个设计轮作为日常截断；交付窗口额外给搜索声明绝对时间预算，为完整 Test 预留90分钟。walltime-budget 是预算截止，明确不等同于收敛。

优化器只生成配置，输出上限为16384 token、单请求180秒；解题 Worker 保持原 temperature=0、maxTokens=393216、请求600秒，不设总体工作流超时。所有方向仍共享全局调用/token预算，没有方向独立上限。

长跑中先写入完整逐题原始记录，再外置大型世界快照、历史诊断与工具轨迹；已评分答案、各项分数和失败次数保持完整。完整原始材料保存在 case-events.jsonl/executions/public-traces，checkpoint及汇总通过明确的artifactProjection指向大字段。回归覆盖原答案完整判分、指标不变、续跑不重复调用及大世界内存投影。

督导进程自动恢复同源码检查点，搜索结束后执行冻结 Test，持续生成正式目录的 summary.json 和 README.zh-CN.md。达到交付时点仍有未完成项会如实显示，后台继续完成，不把部分 Test 均分写成最终成绩。
