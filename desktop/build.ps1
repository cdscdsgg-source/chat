# Builds the portable YouTube subtitle app for Windows (x64).
#
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1 [-Out <folder>] [-NoZip]
#
# Output folder (default: Downloads\YouTubeSubtitle) + YouTubeSubtitle.zip next to it.
# Copy the zip to any Windows 10/11 x64 PC, extract, run YouTubeSubtitle.exe.
# Nothing needs to be installed on the target PC.
#
# Build machine needs: Node + npm install done in the repo (for ffmpeg-static),
# Python 3.11 (py -3.11), and the faster-whisper "small" model in the
# Hugging Face cache (it is downloaded on first use of whisper_local.py).
param(
    [string]$Out = (Join-Path $env:USERPROFILE "Downloads\YouTubeSubtitle"),
    [switch]$NoZip
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Desktop = $PSScriptRoot
$Repo = Split-Path $Desktop -Parent
$Cache = Join-Path $env:TEMP "ytsubs-build-cache"
New-Item -ItemType Directory -Force $Cache | Out-Null

# Pinned: newer ctranslate2/onnxruntime wheels crash on PCs whose
# Visual C++ runtime is older than 14.40 (we ship 14.3x DLLs app-locally).
$PyVersion = "3.11.9"
# ctranslate2 4.4 imports pkg_resources, which setuptools 81+ no longer ships.
$PyPackages = @("faster-whisper==1.2.1", "ctranslate2==4.4.0", "onnxruntime==1.19.2", "setuptools<81")

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Get-Cached($url, $name) {
    $file = Join-Path $Cache $name
    if (-not (Test-Path $file)) {
        Write-Host "    downloading $url"
        Invoke-WebRequest -Uri $url -OutFile "$file.part" -UseBasicParsing
        Move-Item "$file.part" $file
    }
    return $file
}

Step "Preparing $Out"
if (Test-Path $Out) {
    # keep users' saved subtitles if rebuilding in place
    Get-ChildItem $Out -Exclude data | Remove-Item -Recurse -Force
}
$App = Join-Path $Out "app"
$Runtime = Join-Path $Out "runtime"
$Bin = Join-Path $Runtime "bin"
$Py = Join-Path $Runtime "python"
New-Item -ItemType Directory -Force $App, $Bin, $Py | Out-Null

Step "App files"
Copy-Item (Join-Path $Desktop "server.js"), (Join-Path $Desktop "index.html") $App
Copy-Item (Join-Path $Repo "subs.js"), (Join-Path $Repo "subs-ui.js"), (Join-Path $Repo "style.css"), (Join-Path $Repo "whisper_local.py") $App
Copy-Item (Join-Path $Desktop "README.txt") $Out

Step "Chrome extension"
Copy-Item (Join-Path $Repo "extension") (Join-Path $Out "chrome-extension") -Recurse

Step "Node"
Copy-Item (Get-Command node).Source (Join-Path $Runtime "node.exe")

Step "ffmpeg"
$ffmpeg = Join-Path $Repo "node_modules\ffmpeg-static\ffmpeg.exe"
if (-not (Test-Path $ffmpeg)) { throw "ffmpeg-static not installed. Run 'npm install' in $Repo first." }
Copy-Item $ffmpeg $Bin

Step "yt-dlp"
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile (Join-Path $Bin "yt-dlp.exe") -UseBasicParsing

Step "Python $PyVersion (embeddable)"
$pyZip = Get-Cached "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip" "python-$PyVersion-embed-amd64.zip"
Expand-Archive $pyZip -DestinationPath $Py -Force
$pth = Get-ChildItem $Py -Filter "python*._pth" | Select-Object -First 1
$pthLines = Get-Content $pth.FullName | ForEach-Object { if ($_ -eq "#import site") { "import site" } else { $_ } }
Set-Content $pth.FullName -Value (@("Lib\site-packages") + $pthLines) -Encoding ASCII

Step "Python packages: $($PyPackages -join ', ')"
$site = Join-Path $Py "Lib\site-packages"
& py -3.11 -m pip install --quiet --disable-pip-version-check --no-warn-script-location --only-binary=:all: --target $site @PyPackages
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
Get-ChildItem $site -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Remove-Item (Join-Path $site "bin") -Recurse -Force -ErrorAction SilentlyContinue

Step "Visual C++ runtime (app-local)"
foreach ($dll in "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "concrt140.dll") {
    $src = Join-Path $env:WINDIR "System32\$dll"
    if (Test-Path $src) { Copy-Item $src $Py }
}

Step "Whisper model (small)"
$hub = Join-Path $env:USERPROFILE ".cache\huggingface\hub\models--Systran--faster-whisper-small\snapshots"
$snap = Get-ChildItem $hub -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $snap) { throw "Model not found in $hub. Run whisper_local.py once to download it." }
$modelDir = Join-Path $Runtime "models\small"
New-Item -ItemType Directory -Force $modelDir | Out-Null
Get-ChildItem $snap.FullName -File | ForEach-Object { Copy-Item $_.FullName $modelDir }

Step "Launcher"
$icon = Join-Path $Cache "app.ico"
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 64, 64
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = "AntiAlias"
$g.Clear([System.Drawing.Color]::Transparent)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 209, 102))), 2, 2, 60, 60)
$tri = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 25, 18), (New-Object System.Drawing.Point 25, 46), (New-Object System.Drawing.Point 48, 32))
$g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 26, 19, 5))), $tri)
$g.Dispose()
$fs = [System.IO.File]::Create($icon)
[System.Drawing.Icon]::FromHandle($bmp.GetHicon()).Save($fs)
$fs.Close()
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe /codepage:65001 /optimize+ "/win32icon:$icon" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    "/out:$(Join-Path $Out 'YouTubeSubtitle.exe')" (Join-Path $Desktop "launcher.cs")
if ($LASTEXITCODE -ne 0) { throw "launcher build failed" }

$size = (Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Step ("Folder ready: {0} ({1:N0} MB)" -f $Out, $size)

if (-not $NoZip) {
    $zip = "$Out.zip"
    Step "Zipping to $zip"
    if (Test-Path $zip) { Remove-Item $zip }
    # zip without user data (saved subtitles, logs)
    $stage = Join-Path $Cache "zipstage"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory $stage | Out-Null
    $inner = Join-Path $stage (Split-Path $Out -Leaf)
    robocopy $Out $inner /E /XD (Join-Path $Out "data") /NFL /NDL /NJH /NJS /NP | Out-Null
    # Windows' bsdtar writes standard "/" separators (.NET Framework's ZipFile writes "\",
    # which some unzip tools don't treat as folders)
    & "$env:WINDIR\System32\tar.exe" -a -c -f $zip -C $stage (Split-Path $Out -Leaf)
    if ($LASTEXITCODE -ne 0) { throw "zip failed" }
    Remove-Item $stage -Recurse -Force
    Step ("Zip ready: {0} ({1:N0} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
}
