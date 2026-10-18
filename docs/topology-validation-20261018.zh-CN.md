# 本轮验证记录

基于成员 PR #1 的 573644c24f0a1d9892f1431ade51865f6f07f7d5 修改，在独立目录验证。原工作区未提交内容未被覆盖。

## 结果

- 前次 `npm run check` 成功：116 项，116 通过、0 失败、0 跳过，包含官方 AutomationBench 环境。新增 Python 工具后的检查结果见 [工具接入说明](python-tool-and-limits-20261018.zh-CN.md)，两者验证范围不同。
- 首轮为 112 通过、4 跳过；随后安装固定官方环境，补齐 Gmail 参数恢复、Trello 参数恢复、世界隔离与快照重放、官方适配器端到端执行检查，并在同一配置下完成全套检查。原跳过项现已全部通过。
- 完整检查包含 Python SDK 的 15 个底层测试，以及 HTTP 401/402/429/500/timeout、评分器故障六种链路验收。
- 本地模拟模型 → 完整 CLI search → 实际 math-verify 评分 → 冻结 → CLI Test 成功；改动冻结版本后在调用前拒绝。模拟返回覆盖正常接收到的 length；错误答案有效计零，修订正确后正常得分。
- Automation 的真实 Ditto 节点测试覆盖并发任务隔离、18 次工具交互、批量工具请求、后续回合复用请求 ID、完整 length 结束及基础设施失败。
- 搜索测试覆盖固定节点能力、显式依赖是否改变真实输入、组织合法性、重复方案、无进展循环、格式修复上限及候选评测中断后的精确恢复。
- 将本机旧 Automation 模块及未冲突测试覆盖到独立整合目录后，TypeScript 编译通过；旧 provider 接口的 6 项测试全部通过，覆盖 stream/invoke、取消、子进程退出、并发和资源注入。
- 六个数据集均通过 MFlow 原协议的名单、顺序及内容校验；本机五个 AFlow 原始数据的完整文件哈希与锁文件一致。Automation 使用官方任务导出、MFlow 原脚本生成的 200/600 数据。
- MATH 搜索默认重复 1 次、Automation 5 次；显式覆盖参数仍有效。后续按负责人决定将 Test 默认也统一为 1 次，MATH 接入固定 Python 工具，协议升级为 v4；真实 Python 基线镜像尚未取得。

## 基线逐项核对

核对 MFlow `437040f17a17cbf430f3f41227ca64c576cf1056` 的原文件内容：

- `generation-guidance.ts`：除本地新增的来源注释外，整份实现逐字一致（统一文本换行后比较）。
- `repeatedToolCycles`：函数逐字一致；调用包装沿用相同诊断文字和 4/5 次阈值。
- `automationInstruction`：提示文本逐字一致。
- Ditto 原有 MATH 禁止自检前缀已经删除。基线具体文件身份见 `baseline-alignment-20261018.json`。

这里只能证明与上述源码版本对齐。负责人实际基线跑分使用的运行 manifest 尚未提供，仍应核对模型、端点、数据与采样预算。

## 环境及范围

Node v24.14.1，Ditto 0.1.1；独立 Python 环境安装仓库固定的 OpenAI 2.14.0、math-verify 0.9.0、SymPy 1.14.0、ANTLR 4.13.2。回环测试进程设置 `NO_PROXY=127.0.0.1,localhost`，避免系统代理转发本地测试请求。

Automation 另使用官方冻结 uv.lock 的独立 Python 3.13 环境，automation-bench 1.0.6、verifiers 0.2.1；官方依赖 OpenAI 2.53.0 不替换模型桥接的 2.14.0。Windows 沙箱中的 asyncio 本地通信曾阻塞，同一测试在沙箱外通过，未修改官方源码或放宽评分。全套检查日志为本 checkout 的 `official-full-check.log`。

本次未调用真实付费模型、未运行六数据集全量实验、未评测保留的真实 Test 的模型表现；只校验数据身份。正式实验前仍需确认实际模型与剩余配置差异，见 [官方环境与配置核对](official-environment-audit-20261018.zh-CN.md)。旧分数和本版新协议结果不能直接混算。
