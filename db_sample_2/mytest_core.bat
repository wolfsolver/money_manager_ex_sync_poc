@echo off
call %~dp0\..\set_user_passwd.bat
echo user %PB_USER%
echo pass %PB_PASS%
node %~dp0\..\sync_core.js --db=%~dp0\sample_db.mmb --config_file=%~dp0\.lastsync %*
