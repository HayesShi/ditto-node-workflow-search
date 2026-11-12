# 11218：单节点变更与共享资源验证

用户确认：新增、删除、功能修改合计最多一个节点。替换保留节点 ID。必要的依赖边和引用接线单独计算，沿用 max(12, 4*N) 依赖边预算；反向边计两次。不再允许同次增加伴随功能节点，mutation.auxiliary 必须为空。

功能差分比较节点 type、非接线 input 内容及 require；dependsOn 和引用接线不算第二个功能节点。修改字面提示词、操作或约束仍属于功能修改。原有原生 schema、输入类型、固定 host model/generation、system 权限和数据消费校验保持有效。Graph/Loop 定义与全局用户策略仍按原授权搜索。

所有搜索方向共享全局调用与 Token 预算，不再为检索、原生推理、交互或 Memory/Cache 分配独立预算。四方向探索轮转保留。旧实验的预算与快照不改写；旧检查点不得直接用新协议续跑。

错误反馈包含 allowed、actual、added、removed、modified、wiringOnly，以及恢复其他功能节点、保留替换 ID 的修复建议。边差分另外列出具体边。

结果根目录：`output/11218`（工作区根目录）。预检包括完整离线回归、冻结提示词审计和历史提案重放。随后仅在固定 Search 划分中抽取 DROP 16 题、Automation 4 题，各重复一次，基线加最多四个新有效候选、最多十二轮设计、每轮三次提案/修复。Automation 使用已验证的 layered v10 初始工作流。小实验不触碰 Test，不作为正式泛化成绩。

模型和评分器沿用原配置；不修改数据答案、评分逻辑或 Worker system 提示词。优化器 system 同样保持冻结，新的变更限额由 user 请求 immutableProtocol 提交。
