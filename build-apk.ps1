#Requires -Version 5.1
<#
.SYNOPSIS
    يبني ملف الأندرويد StudentApp.apk من واجهة الويب.

.DESCRIPTION
    خطوات البناء بالترتيب:
      ١. التحقّق من أدوات الأندرويد (JDK 17 و Android SDK و Gradle)
      ٢. بناء واجهة الويب            → web/dist
      ٣. نسخها داخل مشروع الأندرويد  → npx cap sync android
      ٤. تجميع الحزمة                → gradlew assembleDebug
      ٥. نسخ الناتج إلى StudentApp.apk بجوار هذا الملف

    الحزمة الناتجة هي نسخة «debug» موقّعة بمفتاح التطوير: تُثبَّت مباشرة على أي
    هاتف بعد السماح بالتثبيت من مصادر غير معروفة، ولا تصلح للنشر على Google Play.

    التطبيق لا يحتوي على خادم. بعد التثبيت يفتح المعلّم شاشة «إعداد الخادم»
    ويكتب عنوان الجهاز الذي يشغّل الخادم على نفس الشبكة، مثل 192.168.1.10:4000

.EXAMPLE
    npm run apk

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-apk.ps1 -SkipWebBuild
    يتخطّى بناء الواجهة ويستخدم web/dist الموجود — مفيد عند تكرار المحاولة.
#>
[CmdletBinding()]
param(
    # مسارات الأدوات. القيم الافتراضية هي ما يثبّته سكربت تهيئة الأدوات.
    [string] $JavaHome = 'D:\android-tools\jdk17',
    [string] $AndroidHome = 'D:\android-tools\sdk',
    [string] $GradleHome = 'D:\android-tools\gradle-home',

    # نسخة Android SDK المطلوبة — مثبّتة في web/android/variables.gradle
    [string] $CompileSdk = 'android-34',

    [switch] $SkipWebBuild
)

$ErrorActionPreference = 'Stop'

# بدون هذا تظهر الرسائل العربية في الطرفية كعلامات استفهام.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Definition
$WebDir     = Join-Path $Root 'web'
$AndroidDir = Join-Path $WebDir 'android'
$ApkSource  = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
$ApkTarget  = Join-Path $Root 'StudentApp.apk'

$script:StepNumber = 0

function Write-Step {
    param([string] $Text)
    $script:StepNumber++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:StepNumber, $Text) -ForegroundColor Cyan
}

function Stop-WithError {
    param([string] $Text, [string] $Hint)
    Write-Host ''
    Write-Host '─────────────────────────────────────────────' -ForegroundColor Red
    Write-Host ("✖ {0}" -f $Text) -ForegroundColor Red
    if ($Hint) { Write-Host $Hint -ForegroundColor Yellow }
    Write-Host '─────────────────────────────────────────────' -ForegroundColor Red
    exit 1
}

# تُنفَّذ الأوامر عبر cmd.exe لأن npm و npx و gradlew ملفات .cmd؛ استدعاؤها
# مباشرة من PowerShell يبتلع رمز الخروج أحياناً فيبدو الفشل نجاحاً.
function Invoke-Step {
    param([string] $WorkingDir, [string] $Command, [string] $FailureText, [string] $Hint)

    Push-Location $WorkingDir
    try {
        & cmd.exe /c $Command
        $code = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Stop-WithError -Text ("{0} (رمز الخروج {1})" -f $FailureText, $code) -Hint $Hint
    }
}

Write-Host ''
Write-Host '  بناء تطبيق الأندرويد — نظام إدارة الطلاب' -ForegroundColor White
Write-Host '  ═══════════════════════════════════════' -ForegroundColor DarkGray

# ── ١) الأدوات ────────────────────────────────────────────────────────────
Write-Step 'التحقّق من أدوات البناء'

if (-not (Test-Path (Join-Path $JavaHome 'bin\java.exe'))) {
    Stop-WithError `
        -Text ("لم يُعثر على Java 17 في: {0}" -f $JavaHome) `
        -Hint "ثبّت JDK 17 في هذا المسار، أو مرّر مساراً آخر:`n  build-apk.ps1 -JavaHome ""C:\path\to\jdk17"""
}

if (-not (Test-Path $AndroidHome)) {
    Stop-WithError `
        -Text ("لم يُعثر على Android SDK في: {0}" -f $AndroidHome) `
        -Hint "ثبّت Android SDK في هذا المسار، أو مرّر مساراً آخر:`n  build-apk.ps1 -AndroidHome ""C:\path\to\sdk"""
}

$PlatformDir = Join-Path $AndroidHome ("platforms\{0}" -f $CompileSdk)
if (-not (Test-Path $PlatformDir)) {
    Stop-WithError `
        -Text ("Android SDK موجود لكن ينقصه {0}" -f $CompileSdk) `
        -Hint ("ثبّته بالأمر:`n  {0}\cmdline-tools\latest\bin\sdkmanager.bat ""platforms;{1}"" ""build-tools;34.0.0"" ""platform-tools""" -f $AndroidHome, $CompileSdk)
}

if (-not (Test-Path $GradleHome)) {
    Stop-WithError `
        -Text ("لم يُعثر على مجلّد Gradle في: {0}" -f $GradleHome) `
        -Hint "يبدو أنّ تهيئة أدوات الأندرويد لم تكتمل بعد. أنشئ المجلّد أو مرّر مساراً آخر بـ -GradleHome"
}

if (-not (Test-Path (Join-Path $AndroidDir 'gradlew.bat'))) {
    Stop-WithError `
        -Text ("مشروع الأندرويد غير موجود في: {0}" -f $AndroidDir) `
        -Hint "أنشئه بالأمر:`n  cd web`n  npx cap add android"
}

# Gradle و Android Gradle Plugin يقرآن هذه المتغيّرات من البيئة فقط.
$env:JAVA_HOME        = $JavaHome
$env:ANDROID_HOME     = $AndroidHome
$env:ANDROID_SDK_ROOT = $AndroidHome
$env:GRADLE_USER_HOME = $GradleHome
$env:Path             = (Join-Path $JavaHome 'bin') + ';' + $env:Path

Write-Host ("    JAVA_HOME        = {0}" -f $JavaHome) -ForegroundColor DarkGray
Write-Host ("    ANDROID_HOME     = {0}" -f $AndroidHome) -ForegroundColor DarkGray
Write-Host ("    GRADLE_USER_HOME = {0}" -f $GradleHome) -ForegroundColor DarkGray

# local.properties يُكتب في كل مرّة لأنّه غير محفوظ في Git (مسار خاص بكل جهاز).
# Gradle يقرأ منه مسار الـ SDK قبل أن ينظر إلى متغيّرات البيئة.
$LocalProperties = Join-Path $AndroidDir 'local.properties'
$SdkDirValue = $AndroidHome.Replace('\', '\\')
@(
    '# ملف يُنشئه build-apk.ps1 تلقائياً في كل بناء — لا تحفظه في Git.',
    '# يخبر Gradle بمكان Android SDK على هذا الجهاز تحديداً.',
    ("sdk.dir={0}" -f $SdkDirValue)
) | Set-Content -Path $LocalProperties -Encoding ASCII

# ── ٢) بناء الواجهة ───────────────────────────────────────────────────────
if ($SkipWebBuild) {
    Write-Step 'تخطّي بناء الواجهة (-SkipWebBuild)'
    if (-not (Test-Path (Join-Path $WebDir 'dist\index.html'))) {
        Stop-WithError -Text 'لا يوجد web/dist جاهز للاستخدام.' -Hint 'أعد التشغيل بدون -SkipWebBuild'
    }
}
else {
    Write-Step 'بناء واجهة الويب (npm run build)'
    Invoke-Step -WorkingDir $WebDir -Command 'npm run build' `
        -FailureText 'فشل بناء واجهة الويب.' `
        -Hint 'راجع أخطاء TypeScript أعلاه. جرّب: cd web && npm install'
}

# ── ٣) نقل الواجهة إلى مشروع الأندرويد ────────────────────────────────────
Write-Step 'نسخ الواجهة إلى مشروع الأندرويد (npx cap sync android)'
Invoke-Step -WorkingDir $WebDir -Command 'npx cap sync android' `
    -FailureText 'فشل أمر cap sync.' `
    -Hint 'تأكّد من تثبيت الحزم: cd web && npm install'

# ── ٤) تجميع الحزمة ───────────────────────────────────────────────────────
Write-Step 'تجميع حزمة الأندرويد (gradlew assembleDebug)'
Write-Host '    قد تستغرق أوّل مرّة عدّة دقائق لتحميل Gradle والمكتبات.' -ForegroundColor DarkGray

if (Test-Path $ApkSource) { Remove-Item $ApkSource -Force }

# البادئة ".\" ضرورية: cmd.exe لا يبحث دائماً في المجلّد الحالي عن ملفات .bat
Invoke-Step -WorkingDir $AndroidDir -Command '.\gradlew.bat assembleDebug --no-daemon' `
    -FailureText 'فشل بناء الأندرويد.' `
    -Hint @"
أكثر الأسباب شيوعاً:
  • نسخة Java غير صحيحة — يجب أن تكون 17 (لا 21 ولا 8)
  • انقطاع الإنترنت أثناء تحميل مكتبات Gradle لأوّل مرّة
  • تراخيص SDK غير مقبولة — نفّذ:
      $AndroidHome\cmdline-tools\latest\bin\sdkmanager.bat --licenses
لمعرفة السبب بالتفصيل:
  cd web\android
  gradlew.bat assembleDebug --stacktrace
"@

# ── ٥) الناتج ─────────────────────────────────────────────────────────────
Write-Step 'نسخ الحزمة الناتجة'

if (-not (Test-Path $ApkSource)) {
    Stop-WithError `
        -Text 'انتهى Gradle بنجاح لكنّ ملف app-debug.apk غير موجود.' `
        -Hint ("كان من المفترض أن يكون في:`n  {0}" -f $ApkSource)
}

Copy-Item -Path $ApkSource -Destination $ApkTarget -Force

$SizeMb = [math]::Round((Get-Item $ApkTarget).Length / 1MB, 2)

Write-Host ''
Write-Host '─────────────────────────────────────────────' -ForegroundColor Green
Write-Host '✔ تم بناء التطبيق بنجاح' -ForegroundColor Green
Write-Host ''
Write-Host ("  الملف : {0}" -f $ApkTarget) -ForegroundColor White
Write-Host ("  الحجم : {0} ميجابايت" -f $SizeMb) -ForegroundColor White
Write-Host '─────────────────────────────────────────────' -ForegroundColor Green

# عنوان الخادم هو أكثر ما يتعثّر فيه المعلّم بعد التثبيت، فنطبع عناوين هذا
# الجهاز على الشبكة المحلية ليكتب أحدها في شاشة «إعداد الخادم».
try {
    $addresses = @(
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -ExpandProperty IPAddress
    )
    if ($addresses.Count -gt 0) {
        Write-Host ''
        Write-Host '  بعد تثبيت التطبيق، اكتب أحد هذه العناوين في «إعداد الخادم»:' -ForegroundColor Yellow
        foreach ($ip in $addresses) {
            Write-Host ("    http://{0}:4000" -f $ip) -ForegroundColor White
        }
        Write-Host '  (شرط أن يكون الخادم يعمل بـ npm start وأن يكون الهاتف على نفس الشبكة)' -ForegroundColor DarkGray
    }
}
catch {
    # مجرّد مساعدة — لا يفشل البناء بسببها.
}

Write-Host ''
exit 0
