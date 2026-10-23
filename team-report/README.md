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
   response sheet, then Home/Away, Submitted by, Cross-check, Match status, Home score, Away score and
   Goals & assists.
2. The final score is compared with the referee's report (Referee Reports Log, set in `REF_LOG_SHEET_ID`) and the
   other club's report – a difference puts **[SCORE MISMATCH]** in the subject. If the other club has reported,
   the match-day checks are compared too; disagreements put **[CLUBS DISAGREE]** in the subject.
   "Unsure" never counts as a disagreement.
3. The office gets the report, copied to the **conference commissioner** (column D of the Assignors tab).
   Every "No" is listed in the subject, e.g. `[No: Physio, Balls]`. Referee assignors are never copied.
4. The submitter gets a copy.

## Setup (about 5 minutes)

1. New Apps Script project (script.google.com → New project), signed in as asexton@apslsoccer.com.
2. Paste `Code.gs`. Add an HTML file named **Index** and paste `Index.html`. Save.
3. Optional – share one club list and one commissioner list with the referee form: paste the referee system's
   **Referee Report Settings** sheet ID into `SETTINGS_SHEET_ID`. Leave blank for a separate **Club Report Settings** sheet.
4. Run **setup** once and approve the permissions.
5. Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone**.
6. Fill in commissioner emails (column D of the Assignors tab), then send a test report.

To update later: Deploy → **Manage deployments** → pencil → **New version** (keeps the same link).
When testing is done, change `OFFICE_EMAIL` to `office@apslsoccer.com`.
