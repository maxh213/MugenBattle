@echo off
cd mugen
start mugen %1 %2 -p1.ai 1 -p2.ai 1 -rounds 1 -log ../matchData.log -s %3 -nomusic -nosound end

:start
tasklist /FI "IMAGENAME eq mugen.exe" 2>NUL | find /I /N "mugen.exe">NUL
if "%ERRORLEVEL%"=="0" goto start
if NOT "%ERRORLEVEL%"=="0" echo Fight Finished!
cd ..
findstr /b "winningteam =" matchData.log