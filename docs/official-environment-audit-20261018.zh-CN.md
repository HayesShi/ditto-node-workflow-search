# 官方环境、数据和配置核对

追加状态：Test 已统一为 1 次，MATH Python 工具已接入，协议升级为 v4；固定基线镜像尚未取得，真实容器执行仍待验证。最新结论见 [Python 工具与限制说明](python-tool-and-limits-20261018.zh-CN.md)。

核对对象为 MFlow `437040f17a17cbf430f3f41227ca64c576cf1056`。2026-10-18 查询到其 main 为 `9279d7d91bbce039656f5cd3a6bb539cea75fe85`，本报告涉及的两份基线配置及公共生成指导内容未变。这里确认仓库公开协议，不代表已经核实基线负责人实际跑分所用的模型端点和运行 manifest。

## 已落实的决定

数据划分使用 `mflow-splits-v1` 发布的成员、顺序和内容，不重新随机划分，也不另加确认集。已逐个验证本机五个 AFlow 原文件的 SHA-256；再用 MFlow 原转换函数生成对应记录，通过其 `splits.py` 的名单、逐记录和整组内容校验。Automation 使用官方环境导出的原始任务，经 MFlow 原脚本准备后同样通过校验。

| 数据集 | 搜索集 | Test 集 | 协议 |
|---|---:|---:|---|
| DROP | 200 | 800 | aflow-fixed-v1 |
| GSM8K | 264 | 1055 | aflow-fixed-v1 |
| HumanEval | 33 | 131 | aflow-fixed-v1 |
| MBPP | 86 | 341 | aflow-fixed-v1 |
| MATH | 119 | 486 | aflow-fixed-v1 |
| AutomationBench | 200 | 600 | automationbench-public-simple-v1 |

Automation 搜索集为 simple 域；Test 为另外六域。旧本机 120/480 划分不符合此协议，不能用于本轮实验。DROP 保留 MFlow 已声明的 5 对跨划分重复题面，不自行去重后继续称为同一协议。

搜索评估次数按**对应 AFlow 基线配置**：

| 数据集 | 每个候选评估次数 | MFlow 依据 |
|---|---:|---|
| MATH | 1 | configs/hb-deepseek-baselines.json 的 aflow.validationRounds |
| AutomationBench | 5 | configs/automationbench-baselines.json 的 aflow.validationRounds |

这表示每个候选对搜索集的每题运行相应次数，再汇总分数；不是搜索候选总数。MFlow 自身方法的 MATH 搜索配置为 5 次，与其 AFlow 基线的 1 次不同，本次按用户要求参照基线。其余四个数据集的对应基线重复次数尚无已核实配置，本轮不推定为 1，保留原默认 5 次。

CLI 已将 MATH 默认改为 1，Automation 默认保持 5，显式 `--repeats` 仍可覆盖。协议升级为 `ditto-topology-flash-20261018-v3`；旧版搜索须重新开始，不混用旧分数或恢复状态。Search 与 Test 继续校验同一执行、评分身份。

## 官方 Automation 环境实测

- Python 3.13.0；官方 AutomationBench commit `4a8e1061254004d9dac807054eed33fad7d1ff14`，源码干净。
- `uv.lock` SHA-256 为 `c7d275af5ad98caa7058edce5806281a340f63781cdff3062622c9c0d5d7c521`。使用 uv 0.13.1、`uv sync --frozen --no-dev` 安装完整官方环境。
- automation-bench 1.0.6、verifiers 0.2.1、OpenAI 2.53.0。官方环境与模型桥接环境分开；桥接环境仍使用仓库固定的 OpenAI 2.14.0。
- `automationIdentity()` 通过源码、锁文件、导入位置及包身份检查。官方 API 检索缓存放在源码外。
- 单独执行官方适配器测试：7 项全部通过、0 跳过。包含此前跳过的 Gmail 参数纠正、Trello 参数纠正、世界隔离/快照重放、实际适配器重试及评分检查。
- 随后使用相同环境运行完整 `npm run check`：116 项全部通过，0 失败、0 跳过，耗时约 62 秒。
- 实际世界修改后官方评分为 1；未修改世界为 0；重放保存快照得到相同评分。文字声称完成不替代状态评分。
- 沙箱中启动超时的调用栈停在 Windows asyncio 的本机 socketpair 初始化；同一环境、源码和测试在沙箱外正常通过。未为绕过它改官方库、桥接协议或超时。

本轮运行产物位于本 checkout 的 `.test-tmp/official-env/`，不上传数据、环境或密钥：`identity.json`、`split-verification.json`、`AutomationBench-source`、`automation-python`、`automation-data` 和 `MFlow`。官方测试日志为 checkout 根目录的 `official-native-tests.log`。

## 正式实验前仍需区分的配置

| 项目 | MFlow 公开基线配置/实现 | Ditto 当前状态 |
|---|---|---|
| 最终 Test 次数 | MATH、Automation 基线各一遍 | 后续已统一为默认 1 次，两个 Test 入口及启动脚本同步 |
| 请求超时 | 配置为 2147483647 ms | 默认 600000 ms，另有 5000 ms 连接超时 |
| 搜索候选上限 | MATH 20；Automation 未设轮数上限、按收敛停止 | CLI 两者默认 20 轮，另有组织深度限制 |
| MATH 工具 | AFlow 基线提供 Programmer，实际可执行 Python | 后续已加入固定 Python 工具并由搜索编排；仍缺基线镜像，未完成真实容器验证 |
| 模型与端点 | 配置声明 deepseek-flash；实际跑分身份需运行记录 | 新 checkout 无 `.env`，尚未调用真实模型核对 |

因此，已确认“Automation 官方环境能执行、能按官方规则评分”和“指定的数据划分、搜索重复次数一致”；不能据此宣称所有实验条件已经完全对齐。MATH 工具已按负责人追加决定接入，尚需相同镜像的实际验证。未开始正式付费实验。

公开配置的并发也不同（Automation 基线 8，Ditto 搜索默认 3）；这是吞吐参数，仍应在实际运行记录中声明。模型服务重试与工作流重试是不同层次，Ditto 现有 3 次请求尝试、最多 5 次工作流尝试并非整体等同 MFlow 的重试策略。

## 使用步骤

从仓库根目录进行只读数据校验：

```powershell
python scripts/verify_mflow_data.py --dataset all-aflow --data-dir ../data/datasets
python scripts/verify_mflow_data.py --dataset automationbench --data-dir .test-tmp/official-env/automation-data
```

第一条验证五个原始 AFlow 数据集；可将 `all-aflow` 换为 `math` 等单个名称。更换路径后必须重新通过校验。锁定依据见 `configs/mflow-data-lock.json`；它锁定全部文件内容和顺序，不仅检查条数。小样本 smoke 可以设 limit，正式运行使用 `--search-limit 0 --test-limit 0`。

本机已验证的 Automation 环境可在新 PowerShell 会话中这样启用：

```powershell
$env:DITTO_AUTOMATION_ROOT = (Resolve-Path .test-tmp/official-env/AutomationBench-source).Path
$env:DITTO_AUTOMATION_PYTHON = (Resolve-Path .test-tmp/official-env/automation-python/Scripts/python.exe).Path
$env:DITTO_AUTOMATION_DATA = (Resolve-Path .test-tmp/official-env/automation-data).Path
$env:DITTO_AUTOMATION_CACHE_DIR = Join-Path (Get-Location) '.test-tmp/official-env/api-cache'
$env:DITTO_PROVIDER_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
$env:MATH_SCORER_PYTHON = $env:DITTO_PROVIDER_PYTHON
$env:PYTHONUTF8 = '1'
$env:NO_PROXY = '127.0.0.1,localhost'
npm run check
```

`DITTO_AUTOMATION_DATA` 用于官方环境测试；正式 CLI 必须显式传 `--data-dir` 指向这份 Automation 数据。不要将官方 Automation Python 当作模型桥接 Python 使用。新机器的克隆、固定版本、uv 安装及导出步骤可参见历史工程指南的环境部分；该指南涉及旧提示、截断策略和单次工程搜索的段落不适用于当前协议。

以上均使用模拟模型或只读数据校验；没有调用付费模型，也没有评测保留 Test 的模型表现。官方环境功能测试使用的是 simple 搜索域任务。
