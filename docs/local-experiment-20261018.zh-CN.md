# 本机 MATH / Automation 实验配置

负责人决定改用本机启动两项实验。服务器准备任务已停止，服务器未运行模型实验。当前协议为 `ditto-topology-flash-20261018-v6`；本轮运行期间不修改执行、工具和评分代码。

| 参数 | MATH | AutomationBench |
|---|---|---|
| 搜索数据 | MFlow 固定 119 条 | MFlow 固定 simple 200 条 |
| 每候选搜索评估 | 1 遍 | 5 遍 |
| 搜索扩展上限 | 20，允许按收敛提前结束 | 无固定轮数上限，按收敛结束 |
| 最终 Test | 冻结后 486 条，各 1 遍 | 冻结后 600 条，各 1 遍 |
| 并发 | 搜索及 Test 样本/模型并发均为 3 | 搜索及 Test 样本/模型并发均为 3 |
| 模型 | deepseek-flash，https://api.deepseek.com | 相同 |
| 生成参数 | 温度 0、max_tokens 393216、n=1、thinking disabled | 相同 |

模型请求期限统一为 2147483647 ms，去掉 Python 桥接的 600 秒隐藏截断。连接期限为 10 秒，对应基线 Undici 的默认值（[官方说明](https://github.com/nodejs/undici/blob/main/docs/docs/api/Connector.md)）。Python 运行仍为 30 秒，Automation 官方环境操作仍为 60 秒。原来的组织大小约束没有在本轮修改。

新增检查覆盖超过 20 次扩展后按收敛停止，以及模拟经历 601 秒后请求仍可在基线长时限内恢复。修改后完整检查为 121 项通过、0 失败、0 跳过，底层 SDK 包含 16 项检查。随后新增镜像配置政策通过构建及 27 项针对性检查。

## Python 镜像的实际身份

已从 Docker 官方仓库拉取 `python:3.12-alpine`，本轮锁定的实际镜像 ID 为：

`sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4`

MFlow 配置记录的是 `sha256:2fc2c915ed384368f492e415d42f7491defbaaa29436b3013e84627fe85b57a6`。按该哈希直接向官方 Python 仓库拉取返回 not found，负责人亦无导出文件。按此次“本机拉取镜像配置并启动”的指示，使用公开 Python 3.12 镜像，并在每次执行身份中保留 `baselineImage` 和 `matchesBaselineImage:false`。不能声称镜像已与基线完全一致，结果报告必须披露该差异。

运行前将标签解析为不可变 ID；实际执行只使用该 ID，不在评测中拉取镜像。搜索、恢复和 Test 持续核对相同身份。默认仍优先寻找原基线镜像，需要显式配置才会选择另一份本地镜像；不存在宿主机 Python 回退。

真实本机 Docker 已完成隔离计算，并跑通实际 Ditto `actor → ACT → OBSERVE → UPDATE → actor → OUTPUT`，真实 math-verify 判分为 1。这里模型是脚本模拟；另一次真实服务预检中 deepseek-flash 返回 2、finish_reason=stop，消耗 13 tokens，确认模型、鉴权与生成参数可用。

## 运行记录

两个独立后台控制进程各自执行完整 search；成功冻结后，使用同一配置启动最终 Test。任何阶段失败都保留日志及状态并退出，不把服务故障的零分当作优化反馈。

- 控制与进度：`.test-tmp/local-20261018/`，含每项的状态 JSON、search/Test 标准输出和错误日志。
- 搜索及评分产物：`runs/local-20261018-v6/`，按 math、automationbench 分目录。
- 密钥仅保存在被忽略的本地 `.env`，不进入提交或报告。

这些是本轮预先声明的运行配置。历史 v4/v5 工具与限制文档描述修改当时的状态，以本文的 v6 本机配置为准。
