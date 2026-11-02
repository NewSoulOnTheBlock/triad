@echo off
rem $OTC engine instance: separate env, keys and port from the $pENGINE instance.
cd /d %~dp0
set DOTENV_CONFIG_PATH=.env.otc
npx tsx src/main.ts
