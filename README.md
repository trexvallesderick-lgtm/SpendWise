# SpendWise

SpendWise is a private, single-user finance tracker made with plain HTML, CSS, and JavaScript. It has no package installation step and does not send financial records to a server.

## Run it

1. Install Python 3 if it is not already available.
2. Open a terminal in this project folder.
3. Start a local web server:

   ```sh
   python3 -m http.server 8000
   ```

4. Open <http://localhost:8000/spendwise.html>.
5. Choose **Create vault** and set a strong password of at least 12 characters.

The local server is recommended because secure browser encryption APIs require a secure context. Stop the server with Ctrl+C when finished.

## Features

- Encrypted local vault with password-based AES-GCM encryption and PBKDF2 key derivation.
- Password unlock, manual lock, and automatic lock after 15 minutes without activity.
- Income and expense transactions with edit, delete, search, date/type/category filters, and CSV export.
- Monthly category budgets with configurable warning thresholds and budget alerts.
- Savings goals, contributions, and progress tracking.
- Six-month income/expense chart, category breakdown, period reports, and print-to-PDF.
- Custom income and expense categories, recurring weekly/monthly transactions, dark mode, and display currency preferences.
- Download and restore encrypted backups.

All monetary amounts are stored as integer cents to avoid floating-point arithmetic in balances and budget calculations. Supported display currencies are USD, EUR, GBP, PHP, CAD, and AUD. Changing the display currency does **not** convert existing amounts.

## Data and security

The vault is encrypted in this browser's local storage. SpendWise does not provide hosted accounts, remote synchronization, an administrator console, server-side authentication, or a database. There is no password reset: a forgotten password cannot decrypt the vault. Clearing browser storage also removes the local vault, so download encrypted backups regularly and keep them somewhere safe.

This local app is suitable for personal use on a trusted device, not as a substitute for a reviewed financial service. Anyone who can access an unlocked browser session can see the data. Use a current browser, lock the vault when stepping away, and do not enter banking credentials or other third-party secrets.

## Project files

```text
spendwise.html
css/
  spendwise.css
js/
  spendwise.js
tests/
  spendwise.test.cjs
```

## Tests

Node.js 18 or newer is required for the built-in test runner. From this folder, run:

```sh
node --test tests/spendwise.test.cjs
```

The tests cover decimal-to-cents conversion, date validation, calendar-period totals, category totals, and budget usage.

## Deployment

The static files can be hosted on any HTTPS-enabled static web host. Upload `spendwise.html`, `css/spendwise.css`, and `js/spendwise.js` while keeping the folder paths unchanged. HTTPS is required for browser cryptography on a deployed site. The data still stays in each user's browser and will not sync between devices.

No SQL setup or environment file is needed for this browser-local version. A production multi-user service would require a separately designed backend, database, authorization model, security review, and account-recovery process.
