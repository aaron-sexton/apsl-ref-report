# APSL Club Post-Match Report

A short compliance check each club files after every match. It asks the same questions as the conference
"APSL Post Match Report 2026-27" Google Form, rebuilt so the answers are clean enough to act on:

- Conference, club and opponent are **dropdowns** (with "Other" for anything not listed) – no more "PK FC" / "Praira Capital".
- The match date is a date picker and is **checked** – no more year "0026".
- Every question is **Yes / No / Unsure** only – no free text in answer columns. A "No" can carry a short note.
- Questions say **whose** job it is (e.g. "Home team had a physio") and cite the handbook section.
- The club says whether it was **home or away**, so each report knows the home team.

Clubs also report the **final score** and **their own goals with assists** (scorer # and name required; assist
optional; minute optional; penalty or opponent own goal). The number of goals listed must match the club's score.
Cards, subs and photos stay with the referee.

## What happens on submit

1. A row is added to the **Club Post-Match Reports** sheet – same column order and headers as the old form's
   response sheet, then Home/Away, Submitted by, Cross-check, Match status, Home score, Away score,
   Goals & assists, Included in digest, Report ID, Last corrected (and a hidden copy of the form for corrections).
2. The submitter gets a copy by email, with a **correct this report** link. **Nothing goes to the office or
   commissioners at this point.**

## One report per club per match

- A second report for the same **date + club + opponent** is refused. The club sees who filed the original (email
  masked) and can have the correction link re-sent – it only ever goes to the person who filed the original.
- The correction link opens the form pre-filled; submitting **replaces** the original row (Last corrected is stamped)
  and the corrected report appears in the next morning's digest, marked "corrected report".
- Set `WEB_APP_URL` in `Code.gs` to the form's GitHub Pages address so emailed correction links open there.

## Morning digest (one email per person, per day)

Every morning at 8 AM (`DIGEST_HOUR`) the script looks at reports received since the last digest. Nothing is sent
on days with no new reports.

- **League office** – one email with the **final score** of each match, grouped by conference, who has reported,
  and who it's still waiting on. Score mismatches are flagged in red and in the subject.
- **Each conference commissioner** (column D of the Assignors tab) – one email with their conference's scores,
  **goals & assists**, and the **issues**:
  - any **No** answer (with the club's note)
  - a **score mismatch** – any two of the referee's report and the two clubs' latest reports give different
    scores (a source that hasn't reported yet is ignored; the referee's score is shown as the result when there is one)
  - the two clubs **disagreeing** on a check ("Unsure" never counts)
  - any **written comment**
- A conference with **no commissioner email** has its issues added to the office digest, so nothing is lost.

Cross-checks run when the digest is built, so a referee or club report that arrives late is still compared. If the
second club reports after a digest has gone out, the match appears again in the next one with both reports.
Referee assignors are never emailed. To send a digest right away, run `sendDailyDigest` from the editor.

## Setup (about 5 minutes)

1. New Apps Script project (script.google.com → New project), signed in as asexton@apslsoccer.com.
2. Paste `Code.gs`. Add an HTML file named **Index** and paste `index.html`. Save.
3. Optional – share one club list and one commissioner list with the referee form: paste the referee system's
   **Referee Report Settings** sheet ID into `SETTINGS_SHEET_ID`. Leave blank for a separate **Club Report Settings** sheet.
4. Check **Project Settings → Time zone** is (GMT-05:00) Eastern Time, so the digest arrives at 8 AM Eastern.
   Then run **setup** once and approve the permissions – it also schedules the daily digest.
5. Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone**.
6. Fill in commissioner emails (column D of the Assignors tab), then send a test report.

7. Share the GitHub Pages copy of this page, not the `/exec` link, so devices signed in to several Google
   accounts can open it. See `../HOSTING.md`.

To update later: Deploy → **Manage deployments** → pencil → **New version** (keeps the same link).
When testing is done, change `OFFICE_EMAIL` to `office@apslsoccer.com`.
