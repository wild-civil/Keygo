@echo off
setlocal
set JDK=D:\Software\HBuilderX\plugins\amazon-corretto
set SDK=D:\Users\1\AppData\Local\Android\SDK
set ANDROID_JAR=%SDK%\platforms\android-34\android.jar
set ROOT=D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground
set SRC=%ROOT%\_build\source\src\main\java\com\keygo\foreground
set STUBS=%ROOT%\_build\stubs
set STUB_OUT=%ROOT%\_build\stub_classes
set OUT=%ROOT%\_build\classes
set STAGE=%ROOT%\_build\aar_stage
set AAR=%ROOT%\android\keygo-foreground.aar

if not exist "%OUT%" mkdir "%OUT%"
if exist "%OUT%\com" rmdir /s /q "%OUT%\com"
if exist "%STUB_OUT%" rmdir /s /q "%STUB_OUT%"
mkdir "%STUB_OUT%"

echo === 1. 预编译 uni-app 桩类（仅编译期，不打进 aar）===
"%JDK%\bin\javac" -encoding UTF-8 --release 8 -d "%STUB_OUT%" ^
  "%STUBS%\io\dcloud\feature\uniapp\annotation\UniJSMethod.java" ^
  "%STUBS%\io\dcloud\feature\uniapp\bridge\UniJSCallback.java" ^
  "%STUBS%\io\dcloud\feature\uniapp\common\UniModule.java"
if errorlevel 1 (echo STUB COMPILE FAILED & exit /b 1)

echo === 2. 编译 KeyGo 真实源码（依赖桩类 + android.jar）===
"%JDK%\bin\javac" -encoding UTF-8 --release 8 -cp "%ANDROID_JAR%;%STUB_OUT%" -d "%OUT%" %SRC%\*.java
if errorlevel 1 (echo COMPILE FAILED & exit /b 1)

echo === 3. 打包 classes.jar（仅含 com.keygo.*）===
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
cd /d "%OUT%"
"%JDK%\bin\jar" cf "%STAGE%\classes.jar" com
if errorlevel 1 (echo JAR FAILED & exit /b 1)

echo === 4. 组装 aar 内容 ===
copy "%ROOT%\_build\source\src\main\AndroidManifest.xml" "%STAGE%\AndroidManifest.xml" >nul
xcopy "%ROOT%\_build\source\src\main\res" "%STAGE%\res\" /E /I /Y >nul
echo. > "%STAGE%\R.txt"

echo === 5. 生成 keygo-foreground.aar ===
cd /d "%STAGE%"
"%JDK%\bin\jar" cf "%AAR%" .
if errorlevel 1 (echo AAR FAILED & exit /b 1)

echo === DONE ===
dir "%AAR%"
endlocal
