# APSL Team Match Report

A club-side version of the Referee Match Report. A manager or club official from either team submits
the result, their own scorers, cards and subs, a roster photo, a view of the officials and match-day
conditions, and a team statement when something happened. It can run alongside the referee form (to
validate it) or on its own (in place of it).

Separate Apps Script project, separate link, separate Drive folder – nothing here changes the referee form.

## What happens on submit

1. Files go to **APSL Team Match Reports / `<date> · Home v Away`** in Drive (both clubs' reports share the match folder).
2. A row is added to the **Team Reports Log** sheet.
3. **Cross-check:** the result is compared with the other club's report and the referee's report for the same
   match (same date, same home and away teams). Any difference puts **[SCORE MISMATCH]** in the email subject.
4. The report is emailed to the league office, copying the **conference commissioner** (column D of the
   Assignors tab). Referee assignors are never copied.
5. The submitter gets a confirmation email.

## Setup (about 5 minutes)

1. Create a **new** Apps Script project (script.google.com → New project), signed in as asexton@apslsoccer.com.
2. Paste `Code.gs`. Add an HTML file named **Index** and paste `Index.html`. Save.
3. Optional – share one club list and one commissioner list with the referee form: paste the referee
   system's **Referee Report Settings** sheet ID into `SETTINGS_SHEET_ID` at the top of `Code.gs`.
   Leave it blank to get a separate **Team Report Settings** sheet.
4. Run **setup** once and approve the permissions.
5. Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone** → Deploy.
6. Test: submit a report and check the office email.

To update later: Deploy → **Manage deployments** → pencil → **New version** → Deploy (keeps the same link).
When testing is done, change `OFFICE_EMAIL` to `office@apslsoccer.com`.

## Notes

- `REF_LOG_SHEET_ID` is already set to the referee system's Referee Reports Log, so cross-checks work as soon
  as both forms are live. Clear it to turn referee cross-checks off.
- Cross-checks run when a **club** report arrives. If the referee's report comes in later, compare in the logs.
- The referee assessment and comments go only to the office and commissioner.
