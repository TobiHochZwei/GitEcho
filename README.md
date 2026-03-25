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

Then there is a button "Backup now". When clicking the app creates a background task that goes through all links, downloads the full code (git Pull) from the main branch in a new directory in a temp folder, then zips this folder and deletes the folder, so only the zip remains. Then the zip file gets copied to the destination (see config.json)

When all backups are created, the statistics file gets written and the site turns green.

Make sure this web app/ node.js app runs on Mac as well as Windows.
