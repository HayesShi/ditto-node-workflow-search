param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [ValidateSet('all','remaining','multi_turn_base','multi_turn_long_context','multi_turn_miss_func','multi_turn_miss_param')][string]$Category='all',
    [int]$MaxTokens=1200000,
    [int]$MaxCalls=80
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$outputPath=[IO.Path]::GetFullPath($OutputDirectory,$projectRoot)
if(Test-Path -LiteralPath (Join-Path $outputPath 'summary.json')) { throw 'Refusing to overwrite an existing validation run; choose a new directory.' }
$vendorRoot=Join-Path $projectRoot '../output/five-dataset-small-20261104/vendor'
$env:PYTHONUTF8='1'
$env:DITTO_PROVIDER_PYTHON=(Resolve-Path -LiteralPath (Join-Path $projectRoot '../ditto-search-coding-v9/.provider-venv/Scripts/python.exe')).Path
$env:DITTO_BFCL_ROOT=(Resolve-Path -LiteralPath (Join-Path $vendorRoot 'gorilla/berkeley-function-call-leaderboard')).Path
$env:DITTO_BFCL_PYTHON=(Resolve-Path -LiteralPath (Join-Path $vendorRoot 'bfcl-env/Scripts/python.exe')).Path
$runArguments=@('--experimental-vm-modules','--env-file-if-exists=../ditto-workflow-search/.env','scripts/validate_official_small.mjs','--datasets','bfcl','--max-calls',"$MaxCalls",'--max-tokens',"$MaxTokens",'--per-case-max-calls','80','--per-case-max-tokens','1200000','--workflow-ms','1200000','--bfcl-data','../output/five-dataset-small-20261104/data/bfcl','--output',$outputPath)
if($Category -eq 'remaining') { $runArguments+=@('--selection','category-balanced','--count','3','--exclude-category','multi_turn_base') }
elseif($Category -eq 'all') { $runArguments+=@('--selection','category-balanced','--count','4') }
else { $runArguments+=@('--category',$Category,'--count','1') }
& node @runArguments
exit $LASTEXITCODE
