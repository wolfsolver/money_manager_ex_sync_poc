@echo off
call set_user_passwd.bat
del db_sample_1\sample_db1.mmb
del db_sample_2\sample_db2.mmb

echo create complete empty db 
copy test_db.mmb db_sample_1\sample_db1.mmb

echo create second db 
node sync_core.js --db=db_sample_2\sample_db2.mmb --create

echo clear server
node sync_core.js --clearServer

echo init db_sample_1
call db_sample_1\mytest_core.bat

echo init db_sample_2
call db_sample_2\mytest_core.bat
