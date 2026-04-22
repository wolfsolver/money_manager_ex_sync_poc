@echo off
call set_user_passwd.bat
del sample_db1.mmb
del sample_db2.mmb
copy test_db.mmb sample_db1.mmb
echo user %PB_USER%
echo pass %PB_PASS%
node sync_core.js --clearServer
node sync_core.js --db=.\sample_db2.mmb --create