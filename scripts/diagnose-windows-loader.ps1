param([Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
try {
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $executables = @(Get-ChildItem 'src-tauri/target/debug' -Filter 'deck_lib-*.exe' -Recurse -File)
    if (!$executables.Count) { throw 'No deck_lib-*.exe found under src-tauri/target/debug.' }

    $dumpbin = $null
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path $vswhere) {
        $dumpbin = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' | Select-Object -First 1
    }
    if (!$dumpbin) { Write-Warning 'VS dumpbin not found; import reports unavailable.' }

    $cdb = (Get-Command cdb.exe -ErrorAction SilentlyContinue).Source
    if (!$cdb) {
        $candidate = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/Debuggers/x64/cdb.exe'
        if (Test-Path $candidate) { $cdb = $candidate }
    }
    if (!$cdb) { Write-Warning 'CDB not installed; missing-symbol evidence limited to static imports.' }

    $index = 0
    foreach ($exe in $executables) {
        # Separate directories avoid collisions between deps/ and newer build/.../out layouts.
        $directory = Join-Path $OutputDirectory ([string](++$index))
        New-Item -ItemType Directory -Path $directory | Out-Null
        $exe.FullName | Set-Content (Join-Path $directory 'source-path.txt')
        Copy-Item -LiteralPath $exe.FullName -Destination $directory
        if ($dumpbin) {
            foreach ($report in @('dependents', 'imports')) {
                try {
                    & $dumpbin /nologo "/$report" $exe.FullName 2>&1 |
                        Tee-Object -FilePath (Join-Path $directory "$report.txt")
                    if ($LASTEXITCODE -ne 0) { Write-Warning "dumpbin /$report exited $LASTEXITCODE" }
                } catch { Write-Warning "dumpbin /${report}: $_" }
            }
        }
        if ($cdb) {
            $process = $null
            try {
                $start = [System.Diagnostics.ProcessStartInfo]::new($cdb)
                $start.UseShellExecute = $false
                # Stop at process creation to enable loader snaps before imports are resolved.
                $commands = '!gflag +sls; sxe -c ".lastevent; kb; q" 0xc0000139; g'
                foreach ($argument in @('-logo', (Join-Path $directory 'cdb.txt'), '-g', '-G', '-xe', 'cpr', '-c', $commands, $exe.FullName)) {
                    $start.ArgumentList.Add($argument)
                }
                $process = [System.Diagnostics.Process]::Start($start)
                if (!$process.WaitForExit(30000)) {
                    $process.Kill($true)
                    Write-Warning 'CDB exceeded 30 seconds; stopped debugger and its child process.'
                } else { Write-Host "CDB exited $($process.ExitCode)" }
            } catch { Write-Warning "CDB diagnostics: $_" }
            finally { if ($process) { $process.Dispose() } }
        }
    }
} catch { Write-Warning "Windows loader diagnostics: $_" }
# Diagnostics must never replace the original cargo failure.
exit 0
