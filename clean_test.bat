@echo off
call set_user_passwd.bat
del db_sample_1\sample_db.mmb
del db_sample_2\sample_db.mmb
copy test_db.mmb db_sample_1\sample_db.mmb
echo user %PB_USER%
echo pass %PB_PASS%
node sync_core.js --clearServer
node sync_core.js --db=db_sample_2\sample_db.mmb --create