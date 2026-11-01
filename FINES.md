# Automatic fine notices (referee form)

When a referee's report marks one of these checklist items as a **Problem**, the referee script drafts a fine:

| Offense | Checklist items | Club | Amount |
| --- | --- | --- | --- |
| No physio / medical personnel (§8.3.2) | Home physio & medical kit | Home team | 1st warning, 2nd $50, 3rd $100, then doubling |
| Home ground / matchday standards (§8.3.3) | Field; goals, nets & corner flags; balls; benches, technical areas & referee table; water for referees | Home team | Same ladder |
| Improper roster form (§4.2.2) | Roster forms & ID checks | The team the referee picks (home, away or both) | Flat $25 |

- **One offense per section per match.** No corner flags and too few balls in the same match is one §8.3.3 offense,
  with both items listed. Physio is counted separately from ground standards.
- Counts run per club per season from `FINES.SEASON_START`. Rejected fines don't count.
- A match marked "Not played" never produces fines. A second referee report for the same match doesn't fine twice.
- Referee fees, kits, coaches, readiness and walkout are reported but never fined automatically.

## What happens

1. **On submit:** a row is added to the **Fines** tab of the Referee Reports Log with Status `Pending`. The office
   (cc info@) and that conference's commissioner get a heads-up listing each fine, the offense number and the amount.
2. **During the hold (48 hours, `FINES.HOLD_HOURS`):**
   - To stop a fine, change its **Status** to `Rejected`.
   - To change the amount, fill in **Amount override** (0 = send as a warning).
3. **After the hold:** the hourly `processFines` trigger emails the club: to the club's contacts, cc office@, info@ and
   the commissioner, with replies going to office@. The offense number and amount are recalculated at that moment,
   so a rejected earlier fine moves the later ones down a step. The row becomes `Sent`.
4. **If the club has no contact email:** the row becomes `Needs club email` and the office is told. Add the email
   (step 5 below), set Status back to `Pending`, and it goes out within the hour.

The notice states the offense, what the referee wrote, the offense number this season, the amount and due date
(14 days, §1.4.2, with the $30 late fee), how to pay (`FINES.PAYMENT_NOTE`), and that appeals follow §8.6.

## Turning it on

1. Paste the new `Code.gs` into the referee script, and the new `index.html` into its **Index** file. Deploy a new version.
2. Run **setup** once. It creates the Fines tab, adds a contact-email column to the Clubs tab, and adds the hourly
   `processFines` trigger.
3. Settings sheet, **Clubs tab, column C:** add each club's contact email(s), comma-separated.
4. Check the Assignors tab has a **commissioner** email (column D) for each conference.
5. Optional: change `FINES.PAYMENT_NOTE` to your real payment instructions.

To pause everything, set `FINES.ENABLED: false` and deploy. Drafted fines stay on the sheet; delete or reject them.
