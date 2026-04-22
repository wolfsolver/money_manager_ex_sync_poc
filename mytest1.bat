@echo off
call set_user_passwd.bat
echo user %PB_USER%
echo pass %PB_PASS%
node sync_sample_category.js --db=.\sample_db1.mmb
