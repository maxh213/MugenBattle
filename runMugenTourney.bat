@echo off
REM Usage: runMugenTourney.bat <fighter1> <fighter2> <stage>
REM Launches a MUGEN match with AI-controlled players and outputs the results.

cd mugen
mugen.exe %1 %2 -p1.ai 1 -p2.ai 1 -rounds 1 -log ..\matchData.log -s %3 -nomusic -nosound end
cd ..

REM Output winning team lines so the Node process can parse them
findstr /b "winningteam =" matchData.log
