# GitHub Backup / AzureDevops Backup

## Technical Stack
This is a node.js application built with Astro.js and background tasks in node.js

## Purpose
This app helps you backing up the code on GitHub.com. It creates offline backups to certain repositories. The URLs to repositories are stored in the file system in a text file. Also the statistics about last backup, etc. are stored in a text file.

## App flow
The app starts in red or green. The background is light red, when there was no backup in the last 24h (read from statistics.csv). The background is green, when there was a backup in the last 24h

Container:
- Environment PAT for Github / AzureDevOps
- User needs to specify per Token the ExpireTime
- Mount Points for the Targets
- GH Cli should be used for all actions (Github)
- Azure DevOps CLI (AzureDevOps)
- The tool should store all avaliable repositorys and the last sync time in a local database (Mound Point for the data files)
- The Tool should run in Configurable cycles via environment the user can specify a cron syntax to shedule
- everything should be configurable via env variables + mound points
- it should be a immutable container so that the data lives outsides via mountpoints
- add an smpt functionality for notifiyin about critical issues or optional successfuly runs with a short summary - warning about PAT Experations per email

Option1:
- Think about a bullet proof mechanismus for backing up the Repository. Data should not be lost. Having a repo and full history is okay. But make it in a way that history can not get lost. Meachnism for a Baclup is git pull (Download in the WebUi via ZIP)

Option2:
- every run creates a zip of the Repo - checksum will decide if we keep that zip. when checksum is same you can delete and keep the existing last version

User can decide withch mode via Evnvironment variable option1 or option2

WebApp features
- Status of all backup repository and source like github / azuredevops
- in case of strategy option1 show a readonly view of the lates state of the repo with possibility to naviagte in the repo (download files / folder / repo via zip)
- in case of option2 show the repos and the list of zips

 Impelementation Strategy:
 - Make the porvides like azuredevops / github in a plugin style to have the possibility to add in future other git tools easily
