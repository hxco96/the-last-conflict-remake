@echo off
rem Signs this PC in to GitHub (opens the browser). Run once.
"C:\Program Files\GitHub CLI\gh.exe" auth login --hostname github.com --git-protocol https --web
"C:\Program Files\GitHub CLI\gh.exe" auth setup-git
