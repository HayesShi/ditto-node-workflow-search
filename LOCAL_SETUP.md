# 本地安装与运行

需要 Node.js 24+ 与 Python 3.11+。在项目目录中运行：

```powershell
npm.cmd ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-local.txt
$env:DITTO_PROVIDER_PYTHON = "$PWD/.venv/Scripts/python.exe"
npm.cmd run check
npm.cmd run test:generated
```

按 .env.example 配置本地 .env，按 data/README.md 准备 pinned 数据。仓库不包含密钥、数据、依赖环境或历史 runs/ 缓存。

编辑 prompts/ 下的中文提示词后运行 `npm.cmd run experiment:user-prompts`，或阅读 [完整入口说明](docs/autonomous-workflow-changes.md)。该入口会调用付费模型；离线测试不会调用真实模型服务。

原 CLI 仍可使用 run-local.ps1。MATH 还需要设置 AFLOW_REFERENCE_ROOT 指向固定版本 AFlow 源码；代码数据集需要 Docker。
