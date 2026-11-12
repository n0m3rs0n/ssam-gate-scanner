# Gate scanner

This repository is only the gate scanner page. It stores no tickets and no passwords. Gate staff sign in with the gate or admin password, scan a ticket QR, or search by surname or ticket number, then confirm check-in or check-out. The records stay in the private spreadsheet.

Live page (after a push): https://n0m3rs0n.github.io/ssam-gate-scanner/

The page talks to the existing gate Apps Script deployment. Name search needs Version 30 of GateWeb (`search` and `act_by_ticket`). Until that version is deployed, QR check-in still works and search will show that the request is not available.

## On the phone
1. Open the scanner page in Safari or Chrome and sign in.
2. Tap Rear camera and scan the guest’s QR, then Confirm.
3. If the QR will not scan, scroll to **Find by name or ticket number**, type at least 3 letters of the surname or a `tix_` number, tap Search, then Check in or Check out and Confirm.
4. Only paid tickets are listed (up to 10). Emails, phone numbers and ticket tokens are never shown.

## Local checks
```
node tests/scanner-search.test.mjs
NODE_PATH=/workspace/ssam-ux-review/node_modules node tests/scanner-ui.harness.mjs
```

Do not put passwords in this repository.
