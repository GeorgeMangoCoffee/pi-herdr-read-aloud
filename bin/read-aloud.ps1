param(
    [string]$File,
    [string]$Voice = 'en-US-AvaMultilingualNeural',
    [string]$Rate = '+0%',
    [switch]$Now,
    [switch]$Stop,
    [switch]$Toggle,
    [switch]$State,
    [string]$Worker
)

$ErrorActionPreference = 'Stop'
$say = Join-Path $env:LOCALAPPDATA 'say'
$readers = Join-Path $say 'readers'
$chunksRoot = Join-Path $say 'chunks'
$pidFile = Join-Path $say 'player.pid'
$logFile = Join-Path $say 'read-aloud.log'
$stateFile = Join-Path $env:USERPROFILE '.pi\agent\extensions\.read-aloud-state.json'
$utf8 = New-Object System.Text.UTF8Encoding $false
New-Item -ItemType Directory -Force $readers, $chunksRoot | Out-Null

function Write-Log([string]$message) {
    Add-Content -Path $logFile -Value ("{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff'), $PID, $message) -Encoding utf8
}

function Test-Alive($id) {
    if (-not $id) { return $false }
    $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
    return [bool]($p -and $p.ProcessName -like 'powershell*')
}

function Get-TicketPid($name) { return (($name -split '-')[-1] -as [int]) }

function Get-PlayerPid {
    if (-not (Test-Path $pidFile)) { return $null }
    return ((Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int])
}

function Stop-All {
    Get-ChildItem $readers -File -ErrorAction SilentlyContinue | ForEach-Object {
        $id = Get-TicketPid $_.Name
        if ($id -and $id -ne $PID -and (Test-Alive $id)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
    $player = Get-PlayerPid
    if ($player -and $player -ne $PID -and (Test-Alive $player)) { Stop-Process -Id $player -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Get-ChildItem $chunksRoot -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-Enabled {
    try { return ((Get-Content -Raw $stateFile | ConvertFrom-Json).enabled -eq $true) } catch { return $false }
}

function Split-Chunks([string]$text) {
    $pieces = New-Object System.Collections.Generic.List[string]
    foreach ($part in [regex]::Split($text, '(?<=[.!?:;])\s+|\r?\n+')) {
        $p = $part.Trim()
        if ($p -notmatch '[\p{L}\p{N}]') { continue }
        while ($p.Length -gt 220) {
            $cut = $p.LastIndexOf(', ', 219)
            if ($cut -lt 60) { $cut = $p.LastIndexOf(' ', 219) }
            if ($cut -lt 60) { $cut = 219 }
            $pieces.Add($p.Substring(0, $cut + 1).Trim())
            $p = $p.Substring($cut + 1).Trim()
        }
        if ($p) { $pieces.Add($p) }
    }
    if ($pieces.Count -gt 0 -and $pieces[0].Length -gt 70) {
        $head = $pieces[0]
        $cut = $head.LastIndexOf(', ', 60)
        if ($cut -lt 20) { $cut = $head.LastIndexOf(' ', 60) }
        if ($cut -ge 20) {
            $pieces[0] = $head.Substring(0, $cut + 1).Trim()
            $pieces.Insert(1, $head.Substring($cut + 1).Trim())
        }
    }
    $chunks = New-Object System.Collections.Generic.List[string]
    $current = ''
    foreach ($p in $pieces) {
        $limit = if ($chunks.Count -eq 0) { 60 } elseif ($chunks.Count -eq 1) { 120 } elseif ($chunks.Count -eq 2) { 180 } else { 260 }
        if ($current -and ($current.Length + 1 + $p.Length) -gt $limit) { $chunks.Add($current); $current = $p }
        elseif ($current) { $current = "$current $p" }
        else { $current = $p }
    }
    if ($current) { $chunks.Add($current) }
    return , $chunks
}

if ($State) { if (Get-Enabled) { 'on' } else { 'off' }; return }

if ($Toggle) {
    $next = -not (Get-Enabled)
    [System.IO.File]::WriteAllText($stateFile, (@{ enabled = $next } | ConvertTo-Json -Compress), $utf8)
    if ($next) { 'on' } else { 'off' }
    return
}

if ($Stop) { Stop-All; 'stopped'; return }

if ($Worker) {
    $ticketName = '{0:D20}-{1}' -f [DateTime]::UtcNow.Ticks, $PID
    $ticket = Join-Path $readers $ticketName
    $dir = Join-Path $chunksRoot $Worker
    try {
        Set-Content -Path $ticket -Value '' -Encoding ascii
        $text = [System.IO.File]::ReadAllText((Join-Path $say "$Worker.txt"), $utf8)
        $chunks = Split-Chunks $text
        if ($chunks.Count -eq 0) { return }
        New-Item -ItemType Directory -Force $dir | Out-Null
        Get-ChildItem $chunksRoot -Directory | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

        $jobs = @{}
        function Start-Synth([int]$i) {
            if ($i -ge $chunks.Count -or $jobs.ContainsKey($i)) { return }
            $txt = Join-Path $dir ('{0:D4}.txt' -f $i)
            $mp3 = Join-Path $dir ('{0:D4}.mp3' -f $i)
            [System.IO.File]::WriteAllText($txt, $chunks[$i], $utf8)
            $p = Start-Process edge-tts -WindowStyle Hidden -PassThru -ArgumentList '--voice', $Voice, "--rate=$Rate", '--file', "`"$txt`"", '--write-media', "`"$mp3`""
            $null = $p.Handle
            $jobs[$i] = $p
        }
        function Wait-Synth([int]$i) {
            $mp3 = Join-Path $dir ('{0:D4}.mp3' -f $i)
            foreach ($attempt in 1, 2) {
                Start-Synth $i
                $jobs[$i].WaitForExit()
                if ($jobs[$i].ExitCode -eq 0 -and (Test-Path $mp3) -and (Get-Item $mp3).Length -gt 0) { return $mp3 }
                $jobs.Remove($i)
            }
            Write-Log "edge-tts failed for chunk $i of $Worker"
            return $null
        }

        Start-Synth 0
        Start-Synth 1
        Start-Synth 2

        while ($true) {
            $ahead = $false
            Get-ChildItem $readers -File | Where-Object { $_.Name -lt $ticketName } | ForEach-Object {
                if (Test-Alive (Get-TicketPid $_.Name)) { $ahead = $true } else { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
            }
            $player = Get-PlayerPid
            $foreign = $player -and $player -ne $PID -and (Test-Alive $player)
            if (-not $ahead -and -not $foreign) { break }
            Start-Sleep -Milliseconds 300
        }
        Set-Content -Path $pidFile -Value $PID -Encoding ascii
        Write-Log "playing $Worker"

        try {
            Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int NotImpl(); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("BFA971F1-4D5E-40BB-935E-967039BFBEE4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager { [PreserveSig] int GetAudioSessionControl(IntPtr g, int f, out IntPtr c); [PreserveSig] int GetSimpleAudioVolume(IntPtr g, int crossProcess, out ISimpleAudioVolume v); }
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume { [PreserveSig] int SetMasterVolume(float v, ref Guid ctx); [PreserveSig] int GetMasterVolume(out float v); [PreserveSig] int SetMute(bool m, ref Guid ctx); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDE {}
public static class SayVolume {
  public static void Full() {
    IMMDevice d; ((IMMDeviceEnumerator)new MMDE()).GetDefaultAudioEndpoint(0, 1, out d);
    var iid = typeof(IAudioSessionManager).GUID; object o; d.Activate(ref iid, 23, IntPtr.Zero, out o);
    ISimpleAudioVolume v; ((IAudioSessionManager)o).GetSimpleAudioVolume(IntPtr.Zero, 0, out v);
    var g = Guid.Empty; v.SetMasterVolume(1.0f, ref g); v.SetMute(false, ref g);
  }
}
'@
            [SayVolume]::Full()
        } catch {}
        Add-Type -Namespace W -Name Mci -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr cb);'

        for ($i = 0; $i -lt $chunks.Count; $i++) {
            Start-Synth ($i + 1)
            Start-Synth ($i + 2)
            Start-Synth ($i + 3)
            $mp3 = Wait-Synth $i
            if (-not $mp3) { continue }
            if ($i -eq 0) { Write-Log ("first audio for $Worker, {0} chunks" -f $chunks.Count) }
            [W.Mci]::mciSendString("open `"$mp3`" type mpegvideo alias clip$i", $null, 0, [IntPtr]::Zero) | Out-Null
            [W.Mci]::mciSendString("play clip$i wait", $null, 0, [IntPtr]::Zero) | Out-Null
            [W.Mci]::mciSendString("close clip$i", $null, 0, [IntPtr]::Zero) | Out-Null
            if ($i + 1 -lt $chunks.Count -and -not $jobs[$i + 1].HasExited) { Write-Log "gap before chunk $($i + 1) of $Worker" }
        }
    } catch {
        Write-Log "worker error: $_"
    } finally {
        Remove-Item $ticket -Force -ErrorAction SilentlyContinue
        if ((Get-PlayerPid) -eq $PID) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
    return
}

if (-not $File -or -not (Test-Path -LiteralPath $File)) { Write-Error 'Nothing to read: file not found.'; exit 1 }
$body = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $File), $utf8)
if (-not $body.Trim()) { Write-Error 'Nothing to read: file is empty.'; exit 1 }
if (-not (Get-Command edge-tts -ErrorAction SilentlyContinue)) { Write-Error 'edge-tts not found.'; exit 1 }

$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + "-r$PID"
[System.IO.File]::WriteAllText((Join-Path $say "$stamp.txt"), $body, $utf8)
if ($Now) { Stop-All }
Write-Log "queued $stamp ($($body.Length) chars, now=$Now)"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Worker', $stamp, '-Voice', $Voice, '-Rate', $Rate | Out-Null
$stamp
