# GitHub Backup

## Technical Stack
This is a node.js application built with Astro.js and background tasks in node.js

## Purpose
This app helps you backing up the code on GitHub.com. It creates offline backups to certain repositories. The URLs to repositories are stored in the file system in a text file. Also the statistics about last backup, etc. are stored in a text file.

## App flow
The app starts in red or green. The background is light red, when there was no backup in the last 24h (read from statistics.csv). The background is green, when there was a backup in the last 24h

Upon start, the app reads 2 files:
 - Repo.json where there are links to the repositories and the branches
 - statistics.csv where the information about the last backups are stored
 - Config.json - with application configuration (e.g. path where the zip-files are copied to)
This data is displayed on the website.

Then there is a button "Backup now". When clicking the app creates a background task that goes through all links, downloads the full code (git Pull) from the main branch in a new directory in a temp folder, then zips this folder and deletes the folder, so only the zip remains. Then the zip file gets copied to the destination (see config.json)

When all backups are created, the statistics file gets written and the site turns green.

Make sure this web app/ node.js app runs on Mac as well as Windows.
