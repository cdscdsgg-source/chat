@echo off
cd /d "%~dp0"
rem groq-key.txt 에 Groq API 키를 한 줄로 넣어두면 자막 생성(음성 인식)에 사용된다
if exist groq-key.txt set /p GROQ_API_KEY=<groq-key.txt
start "" http://localhost:5173
node server.js
