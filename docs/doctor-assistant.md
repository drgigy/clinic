# Doctor Assistant

The staff EMR starts an interview on a paired device running `patient.html`.
The patient device has no login form. A random device credential grants access
only to its assigned session, not to the patient's medical-record collection.

## Setup and use

1. Open `https://neuroclinic.woyz.in/patient.html` on the patient device.
   It automatically appears as a waiting device; no code or QR is needed.
2. In the staff EMR choose **Home > Connect Patient Device** and click
   **Connect** beside that browser. On the patient device press **Enable Device**
   and permit microphone access. Keep this tab open.
3. On later visits, open `https://neuroclinic.woyz.in/patient.html` in the same
   browser and press **Enable Device**. Staff approval is remembered.
4. Click **Doctor Assistant** next to the patient's Edit button. The device
   displays the patient's identity; confirmation starts the voice interview.
5. Press **Stop Conversation**. Wait for save confirmation. A separate
   **Assistant Note - date/time** appears in the medical-record sidebar.

The patient page offers Malayalam, English, and Auto reply languages. Fixed
choices constrain the server's live-session prompt regardless of the patient's
spoken language; Auto follows the patient's Malayalam/English preference.
Changing language reconnects voice with the new prompt while retaining the
transcript. The chat displays assistant questions only, not patient answers.
Answers still enter the recovery transcript and doctor-only summary. This
display change does not eliminate speech recognition errors; unclear words
must be clarified and the resulting note reviewed by the doctor.

Waiting devices receive no patient information until authenticated staff approve
them. The waiting list shows the browser/platform and request time. Only online,
unexpired requests can be approved. Replacing a connected device requires confirmation.
The device credential is remembered in localStorage and does not expire on a
daily schedule. Staff can revoke it from **Connect Patient Device > Disconnect
device**. Clearing browser data, using a different browser, disconnecting, or
replacing the paired device requires staff approval again. Avoid private browsing.
Re-pairing and disconnecting are blocked during active patient conversations.
Neither operation writes to patients or medicalRecords. The old manually paired
12-hour credentials remain supported until expiry for already-open pages.
Legacy QR endpoints remain for compatibility with cached pages, but the current
interface does not require or display QR pairing.

The clinic permits one active interview across staff tabs. Its lock remains
until a note is saved or an empty session is explicitly ended. Clicking the
active patient's button lets staff request a stop on the patient device.
For an offline device, staff can save the answers already received by the server.
The note is patient-reported history with a clearly labelled tentative AI
assessment for the doctor. It is excluded from prescription selection and the
doctor-seen indicator. The assistant entry is read-only in the EMR, with a
manual Delete button requiring confirmation for that entry only. The launch
button appears in the Staff tab only.

## Data preservation

`assistant-functions/records.js` contains the assistant's only write to
`medicalRecords`: `transaction.create()` using `assistant_<session ID>`.
It never updates or deletes a patient document or an existing medical entry.
Duplicate completion requests return the already-created record ID.
The note creation, session completion, and lock release commit atomically.
No data migration is used.

Transcript checkpoints only append to the active session. An old checkpoint
cannot truncate a newer one. The patient page keeps a recovery copy in
sessionStorage, and removes it after confirmed completion. Keep the tab open
until saving succeeds: closing the tab may discard an unsent recovery copy.
A failed summary/save leaves the session available for retry. Empty interviews
do not create a clinical note.

Provisional diagnosis is generated in a separate server-side summary request.
It is stored in the doctor's Assistant Note, and never returned by the patient
API. The live interview prompt prohibits diagnoses or treatment advice.

## Backend deployment

Use only project `clinic-app-cccc0`. Care Companion is a reference and is not
modified or used as this application's backend.

The clinic project requires Blaze billing and a Secret Manager secret named
`DOCTOR_ASSISTANT_GEMINI_KEY` containing the clinic's Gemini API key. Do not
commit keys or paste them into chat. The backend uses Gemini Live for the
interview and Gemini Flash for the structured doctor-only note.

```sh
cd assistant-functions
npm ci
npm test
cd ..
firebase deploy --only functions:doctor-assistant --project clinic-app-cccc0
```

This command deploys only the new function codebase. Do not deploy or change
the existing Firestore rules, medical records, or patient collections.
The endpoint is configured in `assistant-config.js`. The allowed production
origin is `https://neuroclinic.woyz.in`. API keys remain server-side; the browser
receives a short-lived, single-use voice token. Staff calls require a verified
clinic Firebase ID token. Persistent device credentials can be revoked by staff.

Mirror `index.html` to `clinic-layout.html` before publishing the static files.
Publish only after backend deployment succeeds.

## Verification

`npm test` in `assistant-functions` tests the database transaction contract with
synthetic records: preservation, lock competition, save retries, collisions,
checkpoint ordering, empty sessions, and HTML escaping.

`assistant-functions/tests/browser.cjs` uses Playwright and installed Chrome.
Run it with Playwright available in Node's module path. It starts a localhost
server on port 8879 and mocks Firebase, Gemini, and the assistant API. It tests
the patient/staff flow, mobile layout, failed-save recovery, sidebar entry,
assessment visibility, and zero EMR writes to existing records. Screenshots
are written to `/private/tmp/clinic-assistant-review/`.

These tests do not exercise production microphone hardware or a real Gemini
conversation. Verify those on the paired device after deployment.
