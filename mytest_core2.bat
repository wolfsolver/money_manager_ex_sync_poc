@echo off
call set_user_passwd.bat
echo user %PB_USER%
echo pass %PB_PASS%
node sync_core.js --db=.\sample_db2.mmb %*