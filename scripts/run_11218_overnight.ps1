param([string]$OutputRoot='../output/11218/formal-20261113',[string]$DeliveryDeadlineUtc='2026-11-12T22:45:17Z')
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
$root=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot))
if(Test-Path -LiteralPath (Join-Path $root 'profile.json')){throw 'Campaign exists; inspect active-processes/checkpoints before starting another supervisor.'}
New-Item -ItemType Directory -Path $root -Force | Out-Null
$due=[DateTime]::Parse($DeliveryDeadlineUtc).ToUniversalTime()
@{name='11218-formal';startedAt=[DateTime]::UtcNow.ToString('o');deliveryDeadlineAt=$due.ToString('o');searchDeadlineAt=$due.AddMinutes(-90).ToString('o');concurrency=@{drop=16;automationbench=24};searchTasks=200;searchRepeats=5;testTasks=@{drop=800;automationbench=600};testRepeats=3;maxValidEvaluations=20;designLimit=100000;convergence='Top-3 mean unchanged across 5 valid transitions';nodeLimit=1;promptChangesCountAsFunctional=$false;directionCaps=$false;optimizerMaxOutputTokens=16384;optimizerRequestMs=180000;workerRequestMs=600000;sourceCommit=(& git rev-parse HEAD)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'profile.json') -Encoding utf8
$env:PYTHONUTF8='1'
$env:DITTO_PROVIDER_PYTHON=(Resolve-Path -LiteralPath '..\ditto-search-coding-v9\.provider-venv\Scripts\python.exe').Path
$env:DITTO_AUTOMATION_ROOT=(Resolve-Path -LiteralPath '..\output\five-dataset-small-20261104\vendor\AutomationBench').Path
$env:DITTO_AUTOMATION_PYTHON=Join-Path $env:DITTO_AUTOMATION_ROOT '.venv\Scripts\python.exe'
$env:DITTO_AUTOMATION_DATA=(Resolve-Path -LiteralPath '..\output\five-dataset-small-20261104\data\automationbench').Path
$env:DITTO_AUTOMATION_COMPAT='hubspot-association-catalog-v1'
$node=(Get-Command node).Source
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Overnight11218 { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
[Overnight11218]::SetThreadExecutionState(2147483649) | Out-Null
$jobs=@{}
function Read-Manifest($job){
 $path=Join-Path $root ($job.dataset+'/search/'+$(if($job.phase -eq 'test'){'test/manifest.json'}else{'manifest.json'}))
 if(Test-Path -LiteralPath $path){return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json}
 return $null
}
function Launch-Phase($dataset,$phase,$attempt){
 $env:DITTO_PROVIDER_LOG=Join-Path $root ($dataset+'-'+$phase+'-provider.jsonl')
 $heap=if($dataset -eq 'drop'){2048}else{4096}
 $arguments=@("--max-old-space-size=$heap",'--experimental-vm-modules','--env-file-if-exists=../ditto-workflow-search/.env','scripts/run_11218_formal_phase.mjs',('"'+$root+'"'),$dataset,$phase)
 $prefix=Join-Path $root ($dataset+'-'+$phase+'-'+$attempt)
 $p=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput ($prefix+'.stdout.log') -RedirectStandardError ($prefix+'.stderr.log') -PassThru
 return @{dataset=$dataset;phase=$phase;attempt=$attempt;pid=$p.Id;startedAt=$p.StartTime.ToUniversalTime().ToString('o');done=$false}
}
try{
 foreach($d in @('drop','automationbench')){$jobs[$d]=Launch-Phase $d 'search' 1}
 while($true){
  foreach($d in @('drop','automationbench')){
   $j=$jobs[$d];if($j.done){continue}
   $p=Get-Process -Id $j.pid -ErrorAction SilentlyContinue
   if($p -and [Math]::Abs(($p.StartTime.ToUniversalTime()-[DateTime]::Parse($j.startedAt).ToUniversalTime()).TotalSeconds) -lt 2){continue}
   $m=Read-Manifest $j
   if($j.phase -eq 'search' -and $m.status -in @('search-completed','cost-budget-complete') -and (Test-Path -LiteralPath (Join-Path $root ($d+'/search/frozen-selection.json')))){
    $jobs[$d]=Launch-Phase $d 'test' 1
   }elseif($j.phase -eq 'test' -and $m.status -eq 'test-completed'){
    $j.done=$true
   }else{
    @{at=[DateTime]::UtcNow.ToString('o');dataset=$d;phase=$j.phase;attempt=$j.attempt;status=$m.status;error=$m.error;action='resume same source/checkpoints; retain all usage'} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $root 'recoveries.jsonl') -Encoding utf8
    Start-Sleep -Seconds 10
    $jobs[$d]=Launch-Phase $d $j.phase ($j.attempt+1)
   }
  }
  @{at=[DateTime]::UtcNow.ToString('o');jobs=@($jobs.Values);deliveryDeadlineAt=$due.ToString('o')} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'active-processes.json') -Encoding utf8
  & $node 'scripts/report_11218_formal.mjs' $root *> (Join-Path $root 'reporter.log')
  if(@($jobs.Values | Where-Object {!$_.done}).Count -eq 0){break}
  Start-Sleep -Seconds 20
 }
}finally{[Overnight11218]::SetThreadExecutionState(2147483648) | Out-Null}
