# 五数据集官方 JSON 小样本验证（2026-11-04）

这是工程验收子集，不是完整 Search，也不是 Test；没有调用优化器。沿用 MFlow 固定 Search 成员，按 sha256(`42:`+任务 ID) 排序取前缀，不按答案选择题目。静态数据集各取 8 题、每题 1 次；Automation/BFCL 各有 1 个有效限额题次。模型请求及响应名均为 `deepseek-flash`，无法据此独立确认后端精确版本。

| 数据集 | baseline | PR10 可选 user 策略 | 有效判分 |
|---|---:|---:|---:|
| DROP | F1 95.39% | F1 97.92% | 16/16 |
| HumanEval | 8/8 | 8/8 | 16/16 |
| MBPP | 7/8 | 6/8 | 16/16 |
| AutomationBench | 1/1 | 未运行 | 1/1 |
| BFCL | 0/1 | 未运行 | 1/1，未完成对话 |

总共 50 个有效判分记录，只有 26 道不同题目。不同数据集/变体的分数不能合并解释为总体准确率。静态组是整合基线 `a28f777` 上的冻结定义；BFCL 限额组额外采用下述证据去重和 user 说明修复，不能视为同工件直接前后对照。

## Docker 恢复及工程问题

HumanEval/MBPP 初次已生成的 32 份答案，因 Docker 未启动而判分无效。用户恢复引擎后，拉取 `python:3.13-slim`（镜像摘要 `sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1`），校验数据身份和候选哈希，仅重评分，没有新增模型调用。Docker 故障不能列为答错零分。

BFCL 初次状态同时通过 content、structuredContent 和 OBSERVE 消息重复进入提示词；已将 baseline 的证据引用改为原生 structuredContent 一份，保留节点来源标签；只在可编辑 user 策略说明初始状态已提供，system 未改。新增回归覆盖真实 native Graph/Loop 的 bootstrap→call→respond→done，以及初始 schema 只出现一次。

两类世界任务首批均耗尽共享 provider token 预算，四题均无有效整批结果，不报告为 0%：BFCL 6 次请求共 332,532 tokens，Automation 22 次请求共 251,170 tokens。限额复测使用新工件和独立目录，loop.maxIterations=12；这是 12 次图执行，不是 12 次工具调用，生产 baseline 仍为 120。BFCL 复测共 89,160 tokens；Automation 共 20,449 tokens。provider 预算按已知用量事后累计，有在途调用越过软上限的可能。

## 实际工作流与探索边界

DROP/MBPP/HumanEval：`main/context (CONTEXT.LOAD) → main/solve (INFER.REASONING.SAMPLE)`。两种候选的节点图相同，仅 user 策略/首题重复呈现设置不同。此次没有优化器搜索、没有新增 Worker，不应把这批结果解释为多 Worker 搜索能力已充分验证。

Automation：`main/decide (SAMPLE) → main/decision (HOST.DATA.TRANSFORM)`，未完成时进入 `action/act (INTERACTION.ACT.TOOL) → action/observe (INTERACTION.OBSERVE) → action/render (HOST.DATA.TRANSFORM)`，Loop 回到 main 决策。限额复测调用 api_search 三次、api_fetch GET 一次、api_fetch POST 一次，随后 done。完整题面要求查找 jordan@example.com 后新建 Jordan Lee 的 VIP 联系人，因此新建记录本身符合题面。官方断言 `airtable_record_exists` 通过；不据此声称所有中间动作均被该断言覆盖。

BFCL：`main/state (ACT bfcl_state) → main/render` 引导，接 `decision/decide (SAMPLE) → decision/decision` 与同样的 action 子图循环。实际先成功调用 `travel_get_login_status`，随后重复 bfcl_state 五次，没有调用 bfcl_respond 提交任何一轮，耗尽图执行上限。官方 checker 返回 `multi_turn:force_terminated`，模型/策略未完成任务，非接口异常；此 0/1 只代表限额流程，不能外推正式 120 上限的表现。

## 全部非满分样本

### DROP drop:1840（两版）

题目：Which racial groups each individually made up between 0.5 to 2.5% of the population?

相关证据：African American 2.41%，Native American 1.73%，Asian 0.67%；均在范围内。

参考：African American and Asian and Native American。

baseline：`African American (U.S. Census), Native American (U.S. Census), and Asian (U.S. Census)`，F1 0.631579。实体齐全，多余说明导致 token F1 损失。

PR10：`African American and Native American`，F1 0.833333。遗漏 Asian，属于内容错误。两者最终输出与原始末次模型文本一致，无执行器改写。因此平均 F1 上升 2.52 个百分点不能证明理解更好。

### MBPP mbpp:295（两版均 0）

题面：Write a function to return the sum of all divisors of a number. 签名：`sum_div(number)`。

模型均包含数字本身：sum_div(8)=15、sum_div(12)=28。该数据集参考/断言要求 proper divisors：sum_div(8)=7、sum_div(12)=16、sum_div(7)=1。题面“all divisors”与判分实际语义有歧义；记录为有效答错并注明数据语义，不修改评分器，不把参考断言送给优化器，也不按答案增加题目专属规则。提取代码与模型函数一致，无适配错误。

### MBPP mbpp:437（仅 PR10 为 0）

题面：Write a function to remove odd characters in a string. 签名：`remove_odd(str1)`。

PR10 生成 `return str1[::2]`，按从零开始索引理解；数据集按从一开始位置删除奇数位，要求 `python → yhn`，等价保留 `str1[1::2]`。这是位置定义歧义下的模型选择，不是接口或提取 bug。baseline 通过。

### BFCL multi_turn_miss_func_161（0）

首轮公开题意：用给定 client id/secret/refresh token 登录旅行账号，授权 read_write，姓名 Michael Thompson（完整公开题面保存在 executions 中）。仅完成一次登录状态查询，随后重复读状态，未执行认证/提交对话；不是参数接收或评分适配故障。后续未揭示轮次不得作为优化反馈。

## 产物和复现

本地根目录：`../output/five-dataset-small-20261104/`。最终汇总 `final-summary.json` 保留各定义哈希、数据身份、有效组及首批无效组用量。静态各组的 `*.regraded.summary.json` 是代码题恢复后的有效评分；原始失败记录保留。世界有效记录在 `automation-bounded/`、`bfcl-bounded/`；原始预算失败在 `automation-run/`、`bfcl-run/`。各组保存 agent.json、公开题面、原始执行轨迹、provider 诊断和评分细节。源数据与第三方环境不提交仓库。

新增 `scripts/validate_official_small.mjs` 用于有预算的 Search 子集工程验收，代码题先检查 Docker；新增 `scripts/regrade_official_small.mjs` 按数据/工件身份重评分已保存代码答案。

这批证明覆盖范围内生成、原生执行、真实工具和评分能贯通；未证明全部样本无 bug、所有 Worker 组合可用或分数普遍提升。正式优化和冻结后的独立 Test 仍需另跑。

回归验证：`npm test` 首次有 3 个本地 HTTP fixture 测试受到代理 502 影响；仅在本次子进程中将 localhost/127.0.0.1 加入 NO_PROXY，并显式指定已安装 SDK 的 Python 后，完整复跑 **344 项，336 通过、0 失败、8 跳过**。没有放宽断言或修改生产代理配置。新增两个脚本均通过 `node --check`。
