# Clean Garage V10.19.6 — Record State Final Fix

Baseline: clean-garage-v10.19.5-reliability-audit-fixes-full.zip.
Audit and verification date: 2026-09-10.

## Exact results

- Unmodified V10.19.5: `Clean Garage regression tests passed: 75/75`, exit 0.
- Baseline `node --check`: all 12 JavaScript files passed.
- V10.19.6: `Clean Garage regression tests passed: 91/91`, exit 0.
- Final `node --check`: all 12 JavaScript files passed.
- Local HTML, manifest and service-worker reference checks passed in the regression suite.
- Local Database remains the final application section.
- All 75 existing test cases remain; the older-clean expectation was corrected for the requested semantics. Added 16 cases exercising production functions across the persistence/export/restore boundary.

## Fixes

1. Shared timestamp equality is now distinct from an older Shared file. With clean local data, equal timestamps show `Up to date`; an older remote shows `Shared Record is older` with an instruction to upload/replace the latest CleanGarage_Record.json in GitHub. The older file cannot be auto-loaded or offered through the Shared load button. Dirty local data with older/equal remote stays `Local changes not published`. Newer clean remote still auto-loads safely, and newer dirty remote remains a conflict.
2. Every successful state write settles the mutation revision captured with its snapshot, including writes with `markRecordDirty:false`. This fixes immediate Save and confirmed replacement leaving obsolete pending revisions. It does not settle revisions newer than the written snapshot. File export captures its revision and keeps the Record dirty if the user changes data during file delivery or persistence. A failed timestamp write does not mark the Record clean.
3. Wrapped manual Record files now pass the same strict ISO and five-minute future-skew checks as Shared files. Invalid, impossible, future, and missing wrapped export timestamps are rejected before migration/restore. Legacy raw backups without export timestamps remain accepted. After raw restore, unvalidated saved-reference metadata is cleared and `First sync required` persists across reopening; user records and images remain intact.
4. The restore confirmation button resets to `Load and replace` after success or failure.

## Added tests (76–91)

- Five full Shared-check scenarios: equal clean, older clean, older dirty, newer clean, newer dirty. Assertions cover UI text, load-button visibility, local mileage, recovery and state-write counts.
- Immediate mileage mutation then Record Save with the debounce timer still pending.
- Mutation during file delivery remains unpublished.
- Mutation after a write snapshot was captured remains pending.
- Failed export timestamp write stays dirty.
- Manual wrapped load: valid ISO, impossible date, excessive future, missing timestamp.
- Legacy raw restore removes stale reference times and protects first sync after reopen.
- Failed manual replacement preserves local data and resets the button text.
- Confirmed Shared replacement clears obsolete pending revisions and snapshots pending local data for recovery.

The new integration tests run the real app.js, db.js and backup.js functions in a VM. IndexedDB writes and file delivery are substituted at their boundaries for deterministic failures and debounce timing. Actual browser storage is verified separately below.

## Browser test actually executed

Codex in-app Chromium, desktop, at `http://127.0.0.1:8816/REPOSITORY/` with a valid older Shared JSON served from that repository subpath.

Opened the production mileage modal and entered 600123. A test-only page control clicked the production mileage Save button and invoked the production Save Record handler in the same event task, guaranteeing that the pending debounce could not run between those actions. Production IndexedDB and file-delivery code were used, without replacing either boundary.

Observed result:

```json
{
  "version": "10.19.6",
  "result": true,
  "pendingBeforeSave": true,
  "snapshotRevision": 1,
  "pendingAfterSave": false,
  "dirtyAfterSave": false,
  "memoryKm": 600123,
  "indexedDbKm": 600123,
  "recordStatus": "Up to date"
}
```

Clicked CHECK FOR LATEST RECORD. Shared status was `Shared Record is older`; its note instructed uploading/replacing the latest CleanGarage_Record.json in GitHub. Reloaded: mileage remained 600123, local dirty was No, Shared status remained older, and the Shared load button was hidden. Browser error log returned zero entries.

The test control, test JSON, browser fixture and local server are not included in either deliverable ZIP.

## Scope and files

- app.js: APP_VERSION 10.19.6 only.
- backup.js: timestamp arbitration and validation, export revision check, legacy raw first-sync state, button label.
- db.js: revision getter and successful-snapshot settlement.
- sw.js: cache name changed to clean-garage-v10.19.6 only.
- styles.css: version comment only; no layout or style changes.
- RECORD_FILE_GUIDE.md: updated release and behavior instructions.
- tests/regression.test.js: version expectations, corrected older-clean expectation and 16 added cases.
- RELEASE_REPORT.md: this report.

SCHEMA_VERSION stays 17; IndexedDB database version stays 2. No schema migration, store deletion, backend or cloud service was introduced. Shared JSON still resolves as ./CleanGarage_Record.json, uses network/no-store, and has no HTML fallback. Existing PWA update, image, price, Excel PM, string ID/ID 0, Suspension, no-Steering and GitHub size-warning regression cases passed.

## Remaining verification limits

- Safari/iPhone and installed iOS PWA were not tested for this release. Verify the Files/share sheet, cancellation, immediate Save, reopen and update on those devices.
- Real GitHub Pages deployment/CDN was not tested; the browser test used a localhost repository subpath.
- A real V10.19.5-to-V10.19.6 service-worker upgrade was not rerun. Its existing regression checks passed; production PWA logic is unchanged apart from the cache version.
- Future timestamp validation depends on the device clock. Files more than five minutes ahead are rejected until the clock/export is corrected.
- Wrapped files without an exportedAt are deliberately rejected; genuinely raw legacy backups remain loadable with first-sync protection.

## Packages

The full ZIP contains the application, guide, this report and regression tests. The flat GitHub Pages ZIP contains only the 19 original application/guide files at archive root. Neither contains a user CleanGarage_Record.json; keep the current published record and upload the latest saved file separately.
