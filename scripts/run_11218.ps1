$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
$root=[IO.Path]::GetFullPath((Join-Path $project '..\output\11218'))
foreach ($dataset in @('drop','automationbench')) {
    if (Test-Path -LiteralPath (Join-Path $root "$dataset\manifest.json")) { throw "11218 already contains $dataset; inspect its checkpoint instead of launching a duplicate." }
}
if (!(Test-Path -LiteralPath (Join-Path $root 'preflight.json'))) { throw 'Run preflight first.' }
$env:PYTHONUTF8='1'
$env:DITTO_PROVIDER_PYTHON=(Resolve-Path -LiteralPath '..\ditto-search-coding-v9\.provider-venv\Scripts\python.exe').Path
$env:DITTO_AUTOMATION_ROOT=(Resolve-Path -LiteralPath '..\output\five-dataset-small-20261104\vendor\AutomationBench').Path
$env:DITTO_AUTOMATION_PYTHON=Join-Path $env:DITTO_AUTOMATION_ROOT '.venv\Scripts\python.exe'
$env:DITTO_AUTOMATION_DATA=(Resolve-Path -LiteralPath '..\output\five-dataset-small-20261104\data\automationbench').Path
$env:DITTO_AUTOMATION_COMPAT='hubspot-association-catalog-v1'
$node=(Get-Command node).Source
$runs=@()
foreach ($dataset in @('drop','automationbench')) {
    $count=if($dataset -eq 'drop'){16}else{4}
    $env:DITTO_PROVIDER_LOG=Join-Path $root "$dataset-provider.jsonl"
    $arguments=@('--max-old-space-size=4096','--experimental-vm-modules','--env-file-if-exists=../ditto-workflow-search/.env','scripts/validate_official_search_small.mjs','--dataset',$dataset,'--count',"$count",'--output',"../output/11218/$dataset",'--max-valid-evaluations','5','--max-design-rounds','12','--max-proposal-attempts','3','--max-calls','800','--max-tokens','20000000','--initialization','baseline')
    if ($dataset -eq 'automationbench') { $arguments+=@('--controller','layered-v10') }
    $process=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root "$dataset.stdout.log") -RedirectStandardError (Join-Path $root "$dataset.stderr.log") -PassThru
    $runs+=@{dataset=$dataset;pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().ToString('o');arguments=$arguments;count=$count}
}
@{name='11218';at=[DateTime]::UtcNow.ToString('o');project=$project;sourceCommit=(& git rev-parse HEAD);directionResourcePolicy='shared-global-budget-no-direction-caps-v1';runs=$runs} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'launch.json') -Encoding utf8
$runs | ConvertTo-Json -Depth 6
