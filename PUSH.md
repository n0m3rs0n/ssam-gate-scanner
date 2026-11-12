# Push this scanner update (not done)

Nothing has been pushed to GitHub and no Apps Script deployment has been updated.

## What to push
This folder is a clone of https://github.com/n0m3rs0n/ssam-gate-scanner with the name-search commit ready on `main` (see `git log -1`).

```
cd /workspace/ssam-gate-scanner
git status
git log -1 --oneline
git push origin main
```

A `git format-patch` copy is also in `/workspace/ssam-gate-scanner-push/`.

## What is needed
1. **GitHub authentication** for the `n0m3rs0n` account that owns `n0m3rs0n/ssam-gate-scanner`. This box may not be signed in. Use a GitHub login, `gh auth login`, or a personal access token with `repo` scope. Do not put a token in the chat or in this repo.
2. After the push, GitHub Pages updates https://n0m3rs0n.github.io/ssam-gate-scanner/
3. **Deploy Apps Script Version 30 first, or at the same time.** The live gate deployment is still V29 and does not yet have `search` or `act_by_ticket`. QR check-in will keep working if the scanner is pushed early, but name search will not work until V30 GateWeb is pasted and the three existing deployments are pointed at the new version. Do not create new deployments. Do not deploy until Nomerson approves.

## What not to do
- Do not deploy Apps Script from this folder.
- Do not write the gate password anywhere.
- Do not send email.
