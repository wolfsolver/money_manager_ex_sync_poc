@echo off
call %~dp0\..\set_user_passwd.bat
node %~dp0\..\sync_core.js --db=%~dp0\sample_db2.mmb --config_file=%~dp0\.lastsync %*
