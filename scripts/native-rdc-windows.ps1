param(
  [ValidateSet('Install','Start','Stop','Restart','Status','Uninstall')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Native RDC Device'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $RepoRoot 'dist\native-remote\windows-supervisor.js'
$Watchdog = Join-Path $RepoRoot 'dist\native-remote\windows-watchdog.js'

function Assert-Built {
  if (-not (Test-Path $Supervisor) -or -not (Test-Path $Watchdog)) { throw "Native RDC is not built. Run npm run build first." }
}

function Get-NativeTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Install-NativeTask {
  Assert-Built
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $argument = '"' + $Watchdog + '"'
  $taskAction = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Self-hosted Native RDC watchdog for the outbound device supervisor. Contains no credentials.' -Force | Out-Null
  Write-Output 'Native RDC scheduled task installed.'
}

function Start-NativeTask {
  $task = Get-NativeTask
  if (-not $task) { throw 'Native RDC scheduled task is not installed.' }
  Start-ScheduledTask -TaskName $TaskName
  Write-Output 'Native RDC scheduled task start requested.'
}

function Stop-NativeTask {
  $task = Get-NativeTask
  if (-not $task) { return }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Output 'Native RDC scheduled task stop requested.'
}

switch ($Action) {
  'Install' { Install-NativeTask }
  'Start' { Start-NativeTask }
  'Stop' { Stop-NativeTask }
  'Restart' { Stop-NativeTask; Start-Sleep -Milliseconds 500; Start-NativeTask }
  'Status' {
    $task = Get-NativeTask
    if (-not $task) {
      [pscustomobject]@{ Installed=$false; TaskName=$TaskName; State='Missing' }
    } else {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
      [pscustomobject]@{ Installed=$true; TaskName=$TaskName; State=[string]$task.State; LastRunTime=$info.LastRunTime; LastTaskResult=$info.LastTaskResult }
    }
  }
  'Uninstall' {
    Stop-NativeTask
    if (Get-NativeTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Write-Output 'Native RDC scheduled task removed.'
  }
}
