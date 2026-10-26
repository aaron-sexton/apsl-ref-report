/**
 * APSL Club Post-Match Report – backend (Google Apps Script web app)
 *
 * A short compliance check each club files after a match – the same questions as the conference
 * "APSL Post Match Report" Google Form, with dropdowns for clubs, a validated date and fixed answers.
 *
 * Each submission adds a row to the "Club Post-Match Reports" sheet (same column order as the old form's
 * responses) and emails the submitter a copy. Nothing goes to the office or commissioners right away.
 * One report per club per match: a second report for the same date + club + opponent is refused. The
 * confirmation email carries a "correct this report" link that edits the original row instead.
 *
 * Every morning (DIGEST_HOUR, script time zone) sendDailyDigest() looks at the reports received since the
 * last digest and sends at most one email per person:
 *   • League office – the final score of each match, grouped by conference
 *   • Each conference commissioner – their matches' scores and goals, plus the issues: any "No" answer,
 *     a score mismatch (vs the referee's report and the other club), the two clubs disagreeing on a check,
 *     and any written comment. Issues for a conference with no commissioner set go to the office instead.
 * Cross-checks run at digest time, so a referee or club report that arrives later is still compared.
 *
 * Team of the Week: submitting a report unlocks that club's TOTW nominations for the match (its own players
 * and one head coach). Nominations can be changed until 12 pm on the Tuesday after the match; at that point
 * sendTotwDigest() emails each conference commissioner the nominations, grouped by position.
 *
 * Files in this project: Code.gs (this) and an HTML file named Index (the form page).
 * Deploy: Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 * Updates: Deploy → Manage deployments → pencil → New version (keeps the same link).
 */

const CONFIG = {
  OFFICE_EMAIL: 'sextonaaron12@gmail.com',   // TESTING – change to 'office@apslsoccer.com'
  CC: '',                                    // extra addresses on every report, comma-separated
  WEB_APP_URL: 'https://aaron-sexton.github.io/apsl-ref-report/team-report/',                         // link used in emailed correction links – set to the form's public address
                                             // (e.g. the GitHub Pages page or a tinyurl). Blank = this script's /exec link.
  ROOT_FOLDER_NAME: 'APSL Club Post-Match Reports',
  // Optional: the referee system's "Referee Report Settings" sheet ID, so both forms share one Clubs list
  // and one commissioner list (Assignors tab, column D). Leave '' to create a separate settings sheet.
  SETTINGS_SHEET_ID: '',
  // The referee system's "Referee Reports Log" – used to cross-check the final score. Leave '' to skip.
  REF_LOG_SHEET_ID: '1mPYPz7ed7K1qHDAjkNWe4mDNpLeT1cVOBH3eAs1el34',
  DIGEST_HOUR: 8,                            // daily digest time (0–23) in the project's time zone (Project Settings)
};

// Question keys and labels – must match CHECKS in Index.html. The label is the log's column header.
const CHECKS = [
  ['walkout', 'Walkout?'], ['physio', 'Physio?'], ['film', 'Match Film?'], ['balls', 'Balls?'], ['flags', 'Corner Flags?'],
  ['refCare', 'Water, table, & chairs for referees'], ['restroom', 'Public restroom facilities'], ['techArea', 'Technical Area'],
  ['ourCards', 'Did you provide the match officials with substitution cards & a printed roster?'],
  ['oppCards', 'Did your opponent provide the official with substitution cards & a printed roster?'],
];
// Items both clubs see the same way (home-team standards, walkout). Sub cards are compared crosswise.
const SHARED = ['walkout', 'physio', 'film', 'balls', 'flags', 'refCare', 'restroom', 'techArea'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('APSL Club Post-Match Report')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);   // lets the league website embed the form
}

// Conferences and their clubs, as of Fall 2026. Seeds the Clubs tab; edit the tab afterwards.
const DEFAULT_CLUBS = {
  'Constitution Conference (Connecticut)': ['Caribbean FCA', 'Glastonbury Celtic', 'Hermandad Connecticut', 'KO Elites', 'Southwest FC', 'United Holyoke FC'],
  'Delaware River Conference (Pennsylvania & New Jersey)': ['Colonial SC', 'Feelsgood FC', 'Jersey Shore Boca', 'Lighthouse 1893 SC', 'Medford Strikers', 'Oaklyn United FC', 'Persepolis United FC', 'Philadelphia Heritage SC', 'Philadelphia Soccer Club', 'Philadelphia Ukrainian Nationals', 'Real Central NJ Soccer', 'Sewell Old Boys FC', 'Vereinigung Erzgebirge Majors', 'Vidas United FC', 'WC Predators', 'Westtown FC'],
  'Mayflower Conference (Massachusetts)': ['Dorchester City FC', 'Falcons FC', 'Jaguars United FC', 'New England Combine FC', 'Praia Kapital', 'Scrub Nation', 'Soley Leve', 'Somerville United FC', 'South Coast Union', 'Strictly Nos FC'],
  'Metropolitan Conference (New York & New Jersey)': ['Central Park Rangers FC', 'Doxa SC', 'FC Sandzak', 'Hoboken FC 1912', 'Lansdowne Yonkers FC', 'Leros SC', 'NY Athletic Club', 'NY Greek Americans', 'NY Pancyprian Freedoms', 'Richmond County FC', 'SC Vistula Garfield'],
  'Mid-Atlantic Conference - Chesapeake (Maryland)': ['Baltimore City FC', 'Delmarva Thunder', 'Germantown City FC', 'Hybrid FC', 'MoCo 1776', 'PFA APSL', 'Project 90 Gambeta', 'Prospect FC', 'Real Pelayo FC'],
  'Mid-Atlantic Conference - Old Dominion (Virginia)': ['Club Petrolero', 'Grove Soccer United', 'Nova FC', 'Summit Valley United', 'VA Marauders FC'],
  'Mitten Conference (Michigan)': ['Alianza FC', 'Drita SC', 'Grand Rapids SC', 'Hamtramck City FC', 'Inter Detroit', 'Livonia City FC', 'Monroe United', 'World Class FC'],
  'Terminus Conference (Georgia)': ['Alliance SC', 'Bel Calcio FC', 'Buckhead SC', 'Georgia United FC', 'Majestic SC', 'MOBA Upper 90', 'Peachtree FC', 'Prima FC', 'Terminus FC'],
  'Trinity Conference (Texas)': ['AC Arlington FC', 'Chin Hills FC', 'DFW Super Eagles', 'Foro SC', 'ICE FC/Black Ice', 'Midcities FC', 'Texas Rage FC', 'Union Vale FC'],
};

function getSetup() {
  const rows = getClubsSheet().getDataRange().getValues().slice(1), map = {};
  rows.forEach(r => {
    const c = String(r[0] || '').trim(), club = String(r[1] || '').trim();
    if (!c) return;
    (map[c] = map[c] || []);
    if (club && !map[c].includes(club)) map[c].push(club);
  });
  return { conferences: Object.keys(map).map(name => ({ name, clubs: map[name].sort((a, b) => a.localeCompare(b)) })) };
}

// The page can also be hosted outside Apps Script (e.g. GitHub Pages) and call these by plain POST –
// no Google sign-in involved, so devices with several Google accounts signed in work fine.
const API = { getSetup, submitClubReport, getClubReport, resendEditLink, saveNominations };
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents), fn = API[body.action];
    if (!fn) return json({ ok: false, error: 'Unknown action.' });
    return json(fn(...(body.args || [])));
  } catch (err) { console.error(err); return json({ ok: false, error: String(err.message || err) }); }
}
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// Called by the form page.
function submitClubReport(payloadJson) {
  try {
    const d = JSON.parse(payloadJson);
    if (d.website) return { ok: true };                                      // honeypot
    ['division', 'gameDate', 'side', 'club', 'opponent', 'name', 'email'].forEach(k => {
      if (!d[k] || !String(d[k]).trim()) throw new Error(`Missing ${k}.`);
    });
    const a = d.answers || {}, notes = d.notes || {};
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    let id = d.editId || '', edited = false, firstAt = null;
    try {
      const sh = getLog().getSheets()[0], rows = sh.getDataRange().getValues();
      let rowNum = 0;
      if (id) {
        rowNum = rows.findIndex((r, i) => i > 0 && String(r[C.ID]) === String(id)) + 1;
        if (!rowNum) throw new Error('That correction link has expired or is invalid. Please start a new report.');
        edited = true; firstAt = rows[rowNum - 1][C.TS];
      }
      // one report per club per match (ignoring the row being corrected)
      const dup = rows.find((r, i) => i > 0 && i !== rowNum - 1 && isoDay(r[C.DATE]) === isoDay(d.gameDate) && sameTeam(r[C.CLUB], d.club) && sameTeam(r[C.OPP], d.opponent));
      if (dup) return { ok: false, duplicate: true, dupId: String(dup[C.ID] || ''), submittedOn: fmtWhen(dup[C.TS]),
        submittedBy: String(dup[C.NAME] || ''), maskedEmail: maskEmail(dup[1]),
        error: `${d.club} already submitted a report for this match on ${fmtWhen(dup[C.TS])}.` };

      const check = compareWithOtherClub(d);
      const ans = k => a[k] + (a[k] === 'No' && notes[k] ? ` – ${notes[k]}` : '');
      if (!id) id = newId();
      const state = { ...d }; delete state.report; delete state.website; delete state.editId;
      const row = [firstAt || new Date(), d.email, d.division, d.gameDate, d.club, d.opponent, ...CHECKS.map(([k]) => ans(k)),
        d.comments || '', 'I agree', d.side === 'home' ? 'Home' : 'Away', d.name, check.summary,
        d.status || 'Completed', d.homeScore, d.awayScore, goalsText(d.goals), '', id, edited ? new Date() : '', JSON.stringify(state)];
      if (rowNum) sh.getRange(rowNum, 1, 1, row.length).setValues([row]);    // replace the original; digest picks it up again
      else sh.appendRow(row);
    } finally { lock.releaseLock(); }

    // The office and commissioners hear about this in the next morning's digest (sendDailyDigest).
    if (isEmail(d.email)) MailApp.sendEmail({
      to: d.email, name: 'APSL Club Reports',
      subject: `${edited ? 'Corrected' : 'Received'}: ${d.club} post-match report – ${d.home} v ${d.away} (${d.gameDate})`,
      body: `Thanks ${d.name} – the APSL office ${edited ? 'has your corrected' : 'received'} ${d.club}'s report.\n\n` +
            (/^(not played|forfeit)/i.test(d.status || '') ? '' :
              `Team of the Week: your report unlocked ${d.club}'s nominations for this match. Add or change them here until ` +
              `${totwDeadlineText(d.gameDate)}:\n${totwLink(id)}\n\n`) +
            `Need to fix something? Use this link to correct it (it replaces your report – please don't submit a new one):\n${editLink(id)}\n\n` +
            `Your report:\n\n${d.report}`,
    });
    return { ok: true, id, totw: totwFor(findReport(id)) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  }
}

/* ---------------- corrections ---------------- */
// Called by the page when opened from a correction link (?edit=ID).
function getClubReport(id) {
  const rows = getLog().getSheets()[0].getDataRange().getValues();
  const r = rows.find((x, i) => i > 0 && String(x[C.ID]) === String(id));
  if (!r) return { ok: false };
  let state = {}; try { state = JSON.parse(r[C.STATE] || '{}'); } catch (e) {}
  return { ok: true, state, submittedOn: fmtWhen(r[C.TS]), totw: totwFor(r) };
}
// Called by the page when a duplicate is blocked: emails the correction link to whoever filed the original.
function resendEditLink(id) {
  const rows = getLog().getSheets()[0].getDataRange().getValues();
  const r = rows.find((x, i) => i > 0 && String(x[C.ID]) === String(id));
  if (!r || !isEmail(r[1])) return { ok: false };
  MailApp.sendEmail({ to: r[1], name: 'APSL Club Reports',
    subject: `Correction link: ${r[C.CLUB]} post-match report (${isoDay(r[C.DATE])})`,
    body: `Someone tried to submit a second report for ${r[C.CLUB]} v ${r[C.OPP]} (${isoDay(r[C.DATE])}). ` +
          `Each club can file one report per match. To change the report you submitted, use this link:\n${editLink(r[C.ID])}\n\n` +
          `Team of the Week nominations for this match:\n${totwLink(r[C.ID])}` });
  return { ok: true, to: maskEmail(r[1]) };
}
function newId() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = ''; for (let i = 0; i < 10; i++) id += abc[Math.floor(Math.random() * abc.length)];
  return id;
}
function appUrl() {
  return CONFIG.WEB_APP_URL || ScriptApp.getService().getUrl().replace(/\/a\/macros\/[^/]+\//, '/macros/');
}
function editLink(id) { return `${appUrl()}?edit=${encodeURIComponent(id)}`; }
function totwLink(id) { return `${appUrl()}?totw=${encodeURIComponent(id)}`; }
function findReport(id) {
  const rows = getLog().getSheets()[0].getDataRange().getValues();
  return rows.find((x, i) => i > 0 && id && String(x[C.ID]) === String(id)) || null;
}
function maskEmail(e) { const [u, dom] = String(e || '').split('@'); return dom ? `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${dom}` : ''; }
function fmtWhen(d) { try { return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'EEE MMM d, h:mm a'); } catch (e) { return ''; } }

/* ---------------- compare with the other club and the referee ---------------- */
// Log columns: 0 Timestamp | 1 Email | 2 Conference | 3 Date | 4 Club | 5 Opponent | 6-15 answers | 16 Comments |
//              17 Verification | 18 Home/Away | 19 Name | 20 Cross-check | 21 Status | 22 Home score | 23 Away score | 24 Goals |
//              25 Included in digest | 26 Report ID | 27 Last corrected | 28 Saved form (JSON, for corrections)
function compareWithOtherClub(d) {
  const rows = getLog().getSheets()[0].getDataRange().getValues().slice(1);
  const other = rows.filter(r => isoDay(r[3]) === isoDay(d.gameDate) && sameTeam(r[4], d.opponent) && sameTeam(r[5], d.club)).pop();
  const again = false;   // duplicates are refused before this runs
  const lines = [], col = k => 6 + CHECKS.findIndex(([x]) => x === k);
  const mineScore = scoreOf(d.homeScore, d.awayScore, d.status);
  let scoreMismatch = false;
  const scoreLine = (who, h, a, st) => {
    const theirs = scoreOf(h, a, st); if (theirs === '?') return;
    const agree = theirs === mineScore; if (!agree) scoreMismatch = true;
    lines.push(`${agree ? '✓' : '✗'} Score – ${who}: ${d.home} ${theirs} ${d.away}${agree ? '' : ` (this report: ${mineScore})`}`);
  };
  if (again) lines.push(`Note: ${d.club} already filed a report for this match – this is a resubmission.`);
  // referee's report
  if (CONFIG.REF_LOG_SHEET_ID) {
    try {
      const ref = SpreadsheetApp.openById(CONFIG.REF_LOG_SHEET_ID).getSheets()[0].getDataRange().getValues().slice(1)
        .filter(r => isoDay(r[2]) === isoDay(d.gameDate) && sameTeam(r[4], d.home) && sameTeam(r[7], d.away)).pop();
      if (ref) scoreLine(`referee (${ref[9] || 'report'})`, ref[5], ref[6], ref[8]); else lines.push('Referee report: not in yet.');
    } catch (e) { lines.push('Referee log could not be read – check REF_LOG_SHEET_ID.'); }
  }
  const diffs = [];
  if (other) {
    if (other[21] !== undefined && other[21] !== '') scoreLine(other[4], other[22], other[23], other[21]);
    const first = s => String(s || '').split(' – ')[0];
    const mine = d.answers || {};
    SHARED.forEach(k => {
      const theirs = first(other[col(k)]), ours = mine[k];
      if (theirs && ours && theirs !== ours && theirs !== 'Unsure' && ours !== 'Unsure') diffs.push(`${shortLabel(k)}: ${d.club} says ${ours}, ${other[4]} says ${theirs}`);
    });
    // our "we gave sub cards" vs their "opponent gave sub cards", and the reverse
    const cross = [[mine.ourCards, first(other[col('oppCards')]), `${d.club}'s sub cards & roster`],
                   [mine.oppCards, first(other[col('ourCards')]), `${other[4]}'s sub cards & roster`]];
    cross.forEach(([x, y, what]) => { if (x && y && x !== y && x !== 'Unsure' && y !== 'Unsure') diffs.push(`${what}: ${d.club} says ${x}, ${other[4]} says ${y}`); });
    if (diffs.length) lines.push(...diffs.map(s => '✗ ' + s)); else lines.push(`✓ ${other[4]} also reported this match – match-day checks agree.`);
  } else lines.push('Other club: not in yet.');
  const bad = lines.filter(l => l.startsWith('✗'));
  return { lines, disagree: diffs.length > 0, scoreMismatch,
    summary: bad.length ? 'DISAGREE – ' + bad.join(' | ') : lines.filter(l => l.startsWith('✓')).length ? 'Agrees with other reports' : 'No other reports yet' };
}
function scoreOf(h, a, status) {
  const st = String(status || '');
  if (/^not played/i.test(st)) return 'not played';
  if (h === '' || h == null || a === '' || a == null) return '?';
  return `${Number(h)}-${Number(a)}`;
}
function goalsText(goals) {
  return (goals || []).map(g => /^Own goal/.test(g.type) ? `OG${g.min ? ' ' + g.min + "'" : ''}`
    : `#${g.sNum} ${g.sName}${g.type === 'Penalty' ? ' (pen)' : ''}${g.min ? ' ' + g.min + "'" : ''} – A: ${g.aName || g.aNum ? ((g.aNum ? '#' + g.aNum + ' ' : '') + g.aName).trim() : 'none'}`).join('; ');
}
function shortLabel(k) {
  return ({ walkout: 'Walkout', physio: 'Physio', film: 'Match film', balls: 'Balls', flags: 'Corner flags', refCare: 'Referee water/table/chairs',
    restroom: 'Restrooms', techArea: 'Technical area', ourCards: 'Our sub cards & roster', oppCards: 'Opponent sub cards & roster' })[k] || k;
}
function key(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function sameTeam(a, b) {
  const x = key(a), y = key(b);
  return !!x && !!y && (x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))));
}
function isoDay(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '').trim().slice(0, 10);
}

/* ---------------- daily digest ---------------- */
const C = { TS: 0, CONF: 2, DATE: 3, CLUB: 4, OPP: 5, ANS: 6, COMMENTS: 16, SIDE: 18, NAME: 19, STATUS: 21, H: 22, A: 23, GOALS: 24, DIGEST: 25, ID: 26, EDITED: 27, STATE: 28 };
const homeOf = r => (r[C.SIDE] === 'Home' ? r[C.CLUB] : r[C.OPP]);
const awayOf = r => (r[C.SIDE] === 'Home' ? r[C.OPP] : r[C.CLUB]);
const matchKey = r => `${isoDay(r[C.DATE])}|${key(homeOf(r))}|${key(awayOf(r))}`;

// Runs every morning (trigger installed by setup). Safe to run by hand – it only sends what hasn't been sent.
function sendDailyDigest() {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sh = getLog().getSheets()[0], rows = sh.getDataRange().getValues().slice(1);
    const fresh = rows.map((r, i) => i).filter(i => rows[i][C.CLUB] && !rows[i][C.DIGEST]);
    if (!fresh.length) return { sent: 0 };
    let refRows = [];
    if (CONFIG.REF_LOG_SHEET_ID) { try { refRows = SpreadsheetApp.openById(CONFIG.REF_LOG_SHEET_ID).getSheets()[0].getDataRange().getValues().slice(1); } catch (e) { console.error(e); } }

    // every match with a new report, using the latest report from each club (all-time, so late reports still compare)
    const keys = [...new Set(fresh.map(i => matchKey(rows[i])))];
    const matches = keys.map(k => {
      const all = rows.filter(r => r[C.CLUB] && matchKey(r) === k).sort((x, y) => new Date(x[C.TS]) - new Date(y[C.TS]));
      const last = side => all.filter(r => r[C.SIDE] === side).pop() || null;
      const any = all[all.length - 1], home = homeOf(any), away = awayOf(any), date = isoDay(any[C.DATE]);
      const ref = refRows.filter(r => isoDay(r[2]) === date && sameTeam(r[4], home) && sameTeam(r[7], away)).pop() || null;
      return buildMatch({ conf: any[C.CONF], date, home, away, homeRep: last('Home'), awayRep: last('Away'), ref,
        isNew: r => !!r && fresh.some(i => rows[i] === r) });
    }).sort((a, b) => a.conf.localeCompare(b.conf) || a.date.localeCompare(b.date));

    // one email per commissioner; conferences with no commissioner send their issues to the office
    const byCommish = {}, officeIssues = [];
    matches.forEach(m => {
      const to = commissionersFor(m.conf, m.home).split(',').filter(Boolean);
      if (!to.length) { if (m.issues.length) officeIssues.push(m); return; }
      to.forEach(e => (byCommish[e] = byCommish[e] || []).push(m));
    });
    const when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE MMM d');
    const office = [CONFIG.OFFICE_EMAIL, CONFIG.CC].filter(Boolean).join(',');
    MailApp.sendEmail({ to: office, name: 'APSL Club Reports',
      subject: `APSL final scores – ${matches.length} match${matches.length === 1 ? '' : 'es'} (${when})` +
        (matches.some(m => m.mismatch) ? ' [SCORE MISMATCH]' : '') + (officeIssues.length ? ` [${officeIssues.length} need a commissioner]` : ''),
      htmlBody: digestHtml('Final scores from club reports', matches, false) +
        (officeIssues.length ? '<h3 style="font:700 15px Arial;margin:20px 0 6px">Issues – no commissioner email set for these conferences</h3>' +
          digestHtml('', officeIssues, true, true) : '') + footerHtml(),
      body: digestText(matches, false) + (officeIssues.length ? '\n\nISSUES (no commissioner set)\n' + digestText(officeIssues, true, true) : '') });
    Object.entries(byCommish).forEach(([to, ms]) => {
      const n = ms.filter(m => m.issues.length).length;
      MailApp.sendEmail({ to, name: 'APSL Club Reports',
        subject: `Club reports – ${ms.length} match${ms.length === 1 ? '' : 'es'}, ${n ? n + ' with issues' : 'no issues'} (${when})`,
        htmlBody: digestHtml('Your conference – club post-match reports', ms, true) + footerHtml(), body: digestText(ms, true) });
    });
    const stamp = new Date();
    fresh.forEach(i => sh.getRange(i + 2, C.DIGEST + 1).setValue(stamp));
    return { sent: 1 + Object.keys(byCommish).length, matches: matches.length };
  } finally { lock.releaseLock(); }
}

function buildMatch(m) {
  const reps = [['home', m.homeRep], ['away', m.awayRep]].filter(([, r]) => r);
  const sources = [];
  if (m.ref) sources.push({ who: `Referee${m.ref[9] ? ' (' + m.ref[9] + ')' : ''}`, score: scoreOf(m.ref[5], m.ref[6], m.ref[8]) });
  reps.forEach(([, r]) => sources.push({ who: r[C.CLUB], score: scoreOf(r[C.H], r[C.A], r[C.STATUS]) }));
  const known = sources.filter(x => x.score !== '?');
  const distinct = [...new Set(known.map(x => x.score))];
  m.mismatch = distinct.length > 1;
  m.score = m.ref && scoreOf(m.ref[5], m.ref[6], m.ref[8]) !== '?' ? scoreOf(m.ref[5], m.ref[6], m.ref[8]) : distinct.length === 1 ? distinct[0] : '?';
  m.scoreBy = known.map(x => `${x.who} ${x.score}`).join(', ');
  m.reportedBy = [m.ref ? 'referee' : '', ...reps.map(([, r]) => r[C.CLUB])].filter(Boolean);
  m.missing = [m.ref || !CONFIG.REF_LOG_SHEET_ID ? '' : 'referee', m.homeRep ? '' : m.home, m.awayRep ? '' : m.away].filter(Boolean);
  m.goals = reps.filter(([, r]) => r[C.GOALS]).map(([, r]) => `${r[C.CLUB]}: ${r[C.GOALS]}`);
  m.issues = [];
  if (m.mismatch) m.issues.push(`Score mismatch – ${m.scoreBy}`);
  reps.forEach(([side, r]) => {
    const tag = `${r[C.CLUB]} (${side})${m.isNew(r) ? (r[C.EDITED] ? ' – corrected report' : '') : ' – earlier report'}`;
    const nos = CHECKS.map(([k], i) => [k, String(r[C.ANS + i] || '')]).filter(([, v]) => /^No\b/.test(v))
      .map(([k, v]) => shortLabel(k) + (v.includes(' – ') ? ' (' + v.split(' – ').slice(1).join(' – ') + ')' : ''));
    if (nos.length) m.issues.push(`${tag} answered No: ${nos.join('; ')}`);
    if (String(r[C.COMMENTS] || '').trim()) m.issues.push(`${tag} comment: “${String(r[C.COMMENTS]).trim()}”`);
  });
  if (m.homeRep && m.awayRep) diffChecks(m.homeRep, m.awayRep).forEach(x => m.issues.push(`Clubs disagree – ${x}`));
  return m;
}
// Disagreements between the two clubs' answers ("Unsure" never counts).
function diffChecks(a, b) {
  const first = v => String(v || '').split(' – ')[0], col = k => C.ANS + CHECKS.findIndex(([x]) => x === k), out = [];
  const differ = (x, y) => x && y && x !== y && x !== 'Unsure' && y !== 'Unsure';
  SHARED.forEach(k => { const x = first(a[col(k)]), y = first(b[col(k)]); if (differ(x, y)) out.push(`${shortLabel(k)}: ${a[C.CLUB]} ${x}, ${b[C.CLUB]} ${y}`); });
  [[a, b], [b, a]].forEach(([p, q]) => {
    const x = first(p[col('ourCards')]), y = first(q[col('oppCards')]);
    if (differ(x, y)) out.push(`${p[C.CLUB]}'s sub cards & roster: ${p[C.CLUB]} ${x}, ${q[C.CLUB]} ${y}`);
  });
  return out;
}
function niceDate(iso) {
  const [y, mo, d] = String(iso).split('-').map(Number);
  return y ? Utilities.formatDate(new Date(y, mo - 1, d), Session.getScriptTimeZone(), 'EEE MMM d') : String(iso);
}
function scoreLine(m) {
  const sc = m.score === '?' ? (m.mismatch ? 'scores differ – see below' : 'score not reported') : m.score === 'not played' ? 'not played' : m.score.replace('-', ' – ');
  return `${m.home} ${m.score === '?' || m.score === 'not played' ? 'v' : sc} ${m.away}${m.score === '?' || m.score === 'not played' ? ' – ' + sc : ''}`;
}
function digestText(ms, detail, issuesOnly) {
  const out = []; let conf = '';
  ms.forEach(m => {
    if (m.conf !== conf) { conf = m.conf; out.push('', conf.toUpperCase()); }
    if (!issuesOnly) {
      out.push(`  ${niceDate(m.date)}: ${scoreLine(m)}${m.mismatch ? '  [SCORE MISMATCH: ' + m.scoreBy + ']' : ''}`);
      out.push(`    Reported by ${m.reportedBy.join(', ') || 'nobody yet'}${m.missing.length ? ' · waiting on ' + m.missing.join(', ') : ''}`);
      if (detail) m.goals.forEach(g => out.push(`    Goals – ${g}`));
    } else out.push(`  ${niceDate(m.date)}: ${scoreLine(m)}`);
    if (detail || issuesOnly) m.issues.forEach(x => out.push(`    ⚠ ${x}`));
  });
  return out.join('\n').trim();
}
function digestHtml(title, ms, detail, issuesOnly) {
  const h = escapeHtml; let conf = '', out = title ? `<h2 style="font:800 18px Arial;color:#003da6;margin:0 0 4px">${h(title)}</h2>` : '';
  ms.forEach(m => {
    if (m.conf !== conf) { conf = m.conf; out += `<h3 style="font:700 14px Arial;text-transform:uppercase;letter-spacing:.04em;color:#1f1f1f;margin:18px 0 6px;border-bottom:2px solid #ec0332;padding-bottom:3px">${h(conf)}</h3>`; }
    out += `<div style="font:14px/1.45 Arial;margin:0 0 10px;padding:8px 10px;border:1px solid ${m.mismatch ? '#ec0332' : '#dfe3ec'};border-radius:8px;background:${m.mismatch ? '#fde6eb' : '#fff'}">` +
      `<b>${h(scoreLine(m))}</b> <span style="color:#5f6675">· ${h(niceDate(m.date))}</span>` +
      (m.mismatch ? `<div style="color:#ec0332;font-weight:700">Score mismatch: ${h(m.scoreBy)}</div>` : '') +
      (issuesOnly ? '' : `<div style="color:#5f6675;font-size:12px">Reported by ${h(m.reportedBy.join(', ') || 'nobody yet')}${m.missing.length ? ' · waiting on ' + h(m.missing.join(', ')) : ''}</div>`) +
      (detail && !issuesOnly ? m.goals.map(g => `<div style="font-size:13px">⚽ ${h(g)}</div>`).join('') : '') +
      ((detail || issuesOnly) && m.issues.filter(x => !x.startsWith('Score mismatch')).length
        ? `<ul style="margin:6px 0 0;padding-left:18px">${m.issues.filter(x => !x.startsWith('Score mismatch')).map(x => `<li>${h(x)}</li>`).join('')}</ul>` : '') + '</div>';
  });
  return out;
}
function footerHtml(what) {
  let url = ''; try { url = getLog().getUrl ? getLog().getUrl() : ''; } catch (e) {}
  const sheet = url ? `<a href="${url}">Club Post-Match Reports</a>` : 'Club Post-Match Reports';
  return `<p style="font:12px Arial;color:#5f6675;margin-top:16px">${what === 'totw'
    ? `Every nomination is on the TOTW Nominations tab of the ${sheet} sheet.` : `Full answers, goals and assists are in the ${sheet} sheet.`}</p>`;
}

/* ---------------- Team of the Week ---------------- */
// Unlocked by a club's match report: the club nominates its own players (and at most one head coach) from that match.
const TOTW_POS = ['GK', 'DEF', 'MID', 'FWD', 'Head coach'];
const TOTW_MAX_PLAYERS = 11;
// TOTW Nominations tab: 0 Received | 1 Conference | 2 Week (deadline Tuesday) | 3 Match date | 4 Club | 5 Opponent |
// 6 Position | 7 Name | 8 # | 9 Why | 10 Submitted by | 11 Email | 12 Report ID | 13 Home team | 14 Sent to commissioner
const T = { TS: 0, CONF: 1, WEEK: 2, DATE: 3, CLUB: 4, OPP: 5, POS: 6, NAME: 7, NUM: 8, WHY: 9, BY: 10, EMAIL: 11, ID: 12, HOME: 13, SENT: 14 };

function getTotwSheet() {
  const ss = getLog();
  let sh = ss.getSheetByName('TOTW Nominations');
  if (!sh) {
    sh = ss.insertSheet('TOTW Nominations');
    sh.appendRow(['Received', 'Conference', 'Week (deadline Tue)', 'Match date', 'Club', 'Opponent', 'Position', 'Name', '#',
      'Why', 'Submitted by', 'Email', 'Report ID', 'Home team', 'Sent to commissioner']);
    sh.getRange('C:D').setNumberFormat('@');
    sh.setFrozenRows(1);
  }
  return sh;
}
// Nominations close at 12 pm (script time zone) on the first Tuesday after the match.
function totwDeadline(matchDay) {
  const [y, m, d] = isoDay(matchDay).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  do t.setUTCDate(t.getUTCDate() + 1); while (t.getUTCDay() !== 2);
  const week = t.toISOString().slice(0, 10);
  return { week, at: Utilities.parseDate(week + ' 12:00', Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') };
}
function totwDeadlineText(matchDay) {
  try { return Utilities.formatDate(totwDeadline(matchDay).at, Session.getScriptTimeZone(), "EEEE MMM d 'at' h:mm a z"); } catch (e) { return 'Tuesday at 12 pm'; }
}
// What the page needs to show the Team of the Week step for one report.
function totwFor(r) {
  if (!r) return null;
  const { week, at } = totwDeadline(r[C.DATE]);
  const played = !/^(not played|forfeit)/i.test(String(r[C.STATUS] || ''));
  const nominations = getTotwSheet().getDataRange().getValues().slice(1).filter(x => String(x[T.ID]) === String(r[C.ID]))
    .map(x => ({ pos: String(x[T.POS]), name: String(x[T.NAME]), num: String(x[T.NUM] || ''), why: String(x[T.WHY] || '') }));
  return { id: String(r[C.ID]), played, open: played && new Date() < at, deadline: totwDeadlineText(r[C.DATE]), week,
    club: String(r[C.CLUB]), opponent: String(r[C.OPP]), date: isoDay(r[C.DATE]), conf: String(r[C.CONF]), nominations };
}
// Called by the page. Replaces this report's nominations with the list given (an empty list removes them).
function saveNominations(id, listJson) {
  try {
    const list = JSON.parse(listJson || '[]');
    if (!Array.isArray(list)) throw new Error('Nominations should be a list.');
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      const r = findReport(id);
      if (!r) throw new Error("We couldn't find your match report. Submit the report first – that unlocks Team of the Week.");
      const info = totwFor(r);
      if (!info.played) throw new Error('Team of the Week nominations need a match that was played.');
      if (!info.open) throw new Error(`Nominations for this match closed ${info.deadline}.`);
      const clean = list.map(n => ({ pos: String(n.pos || '').trim(), name: String(n.name || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        num: String(n.num || '').trim().slice(0, 4), why: String(n.why || '').trim().slice(0, 300) }));
      clean.forEach((n, i) => {
        if (!TOTW_POS.includes(n.pos)) throw new Error(`Nominee ${i + 1}: pick a position.`);
        if (!n.name) throw new Error(`Nominee ${i + 1}: the name is missing.`);
        if (!n.why) throw new Error(`Nominee ${i + 1}: say what they did.`);
      });
      if (clean.filter(n => n.pos === 'Head coach').length > 1) throw new Error('Only one head coach can be nominated.');
      if (clean.filter(n => n.pos !== 'Head coach').length > TOTW_MAX_PLAYERS) throw new Error(`Nominate at most ${TOTW_MAX_PLAYERS} players.`);
      const names = clean.map(n => key(n.name));
      if (names.some((x, i) => names.indexOf(x) !== i)) throw new Error('The same person is listed twice.');

      const sh = getTotwSheet(), data = sh.getDataRange().getValues();
      for (let i = data.length - 1; i >= 1; i--) if (String(data[i][T.ID]) === String(id)) sh.deleteRow(i + 1);
      clean.forEach(n => sh.appendRow([new Date(), r[C.CONF], info.week, isoDay(r[C.DATE]), r[C.CLUB], r[C.OPP], n.pos, n.name, n.num,
        n.why, r[C.NAME], r[1], String(id), homeOf(r), '']));
    } finally { lock.releaseLock(); }

    const r = findReport(id), info = totwFor(r);
    if (isEmail(r[1])) MailApp.sendEmail({ to: r[1], name: 'APSL Club Reports',
      subject: `Team of the Week: ${info.nominations.length} nomination${info.nominations.length === 1 ? '' : 's'} saved – ${r[C.CLUB]} (${isoDay(r[C.DATE])})`,
      body: (info.nominations.length ? info.nominations.map(n => `  ${n.pos}: ${n.name}${n.num ? ' #' + n.num : ''} – ${n.why}`).join('\n')
        : '  (no nominations)') + `\n\nYou can change these until ${info.deadline}:\n${totwLink(id)}` });
    return { ok: true, totw: info };
  } catch (err) {
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  }
}

// Runs Tuesdays at 12 pm (trigger installed by setup). Sends each commissioner the nominations whose deadline has
// passed and that haven't been sent yet. Conferences with no commissioner email go to the office. Safe to run by hand.
function sendTotwDigest() {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sh = getTotwSheet(), rows = sh.getDataRange().getValues().slice(1), now = new Date();
    const due = rows.map((r, i) => i).filter(i => rows[i][T.NAME] && !rows[i][T.SENT] && totwDeadline(rows[i][T.DATE]).at <= now);
    if (!due.length) return { sent: 0 };
    const office = [CONFIG.OFFICE_EMAIL, CONFIG.CC].filter(Boolean).join(',');
    const byTo = {};
    due.forEach(i => {
      const r = rows[i], to = commissionersFor(r[T.CONF], r[T.HOME]) || office;
      (byTo[to] = byTo[to] || []).push(r);
    });
    Object.entries(byTo).forEach(([to, list]) => {
      const confs = [...new Set(list.map(r => String(r[T.CONF])))].sort();
      const weeks = [...new Set(list.map(r => String(r[T.WEEK])))].sort();
      const short = c => c.replace(/\s*\(.*\)$/, '').replace(/ Conference/, '');
      MailApp.sendEmail({ to, name: 'APSL Club Reports',
        subject: `Team of the Week nominations – ${confs.map(short).join(', ')} (${list.length}, week of ${weeks.map(niceDate).join(', ')})`,
        htmlBody: totwHtml(confs, list) + footerHtml('totw'), body: totwText(confs, list) });
    });
    const stamp = new Date();
    due.forEach(i => sh.getRange(i + 2, T.SENT + 1).setValue(stamp));
    return { sent: Object.keys(byTo).length, nominations: due.length };
  } finally { lock.releaseLock(); }
}
function totwGroups(confs, list) {
  return confs.map(conf => {
    const mine = list.filter(r => String(r[T.CONF]) === conf);
    return { conf, clubs: [...new Set(mine.map(r => String(r[T.CLUB])))].sort(),
      byPos: TOTW_POS.map(pos => [pos, mine.filter(r => r[T.POS] === pos)]).filter(([, rs]) => rs.length) };
  });
}
const totwLine = r => `${r[T.NAME]}${r[T.NUM] ? ' #' + r[T.NUM] : ''} – ${r[T.CLUB]}: ${r[T.WHY]} (v ${r[T.OPP]}, ${niceDate(isoDay(r[T.DATE]))})`;
function totwText(confs, list) {
  const out = ['Team of the Week nominations from club post-match reports.', ''];
  totwGroups(confs, list).forEach(g => {
    out.push(g.conf.toUpperCase());
    g.byPos.forEach(([pos, rs]) => { out.push(`  ${pos}`); rs.forEach(r => out.push(`    ${totwLine(r)}`)); });
    out.push(`  Nominated by: ${g.clubs.join(', ')}`, '');
  });
  return out.join('\n').trim();
}
function totwHtml(confs, list) {
  const h = escapeHtml;
  let out = '<h2 style="font:800 18px Arial;color:#003da6;margin:0 0 4px">Team of the Week nominations</h2>' +
    '<p style="font:13px Arial;color:#5f6675;margin:0 0 6px">From club post-match reports. Clubs nominate their own players.</p>';
  totwGroups(confs, list).forEach(g => {
    out += `<h3 style="font:700 14px Arial;text-transform:uppercase;letter-spacing:.04em;color:#1f1f1f;margin:18px 0 6px;border-bottom:2px solid #ec0332;padding-bottom:3px">${h(g.conf)}</h3>`;
    g.byPos.forEach(([pos, rs]) => {
      out += `<div style="font:700 13px Arial;color:#003da6;margin:10px 0 4px">${h(pos)}</div><ul style="margin:0;padding-left:18px;font:14px/1.45 Arial">` +
        rs.map(r => `<li><b>${h(r[T.NAME])}${r[T.NUM] ? ' #' + h(r[T.NUM]) : ''}</b> – ${h(r[T.CLUB])}: ${h(r[T.WHY])} ` +
          `<span style="color:#5f6675">(v ${h(r[T.OPP])}, ${h(niceDate(isoDay(r[T.DATE])))})</span></li>`).join('') + '</ul>';
    });
    out += `<p style="font:12px Arial;color:#5f6675;margin:8px 0 0">Nominated by: ${h(g.clubs.join(', '))}</p>`;
  });
  return out;
}

/* ---------------- storage ---------------- */
function getRootFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const folder = DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
  props.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}
function logRow(row) { getLog().getSheets()[0].appendRow(row); }
function getLog() {
  const props = PropertiesService.getScriptProperties();
  let ss, id = props.getProperty('LOG_SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create('Club Post-Match Reports');
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder());
    const sh = ss.getSheets()[0];
    sh.appendRow(['Timestamp', 'Email Address', 'Conference', 'Date of the Match', "Your Club's Name", 'Your Opponent',
      ...CHECKS.map(c => c[1]), 'Other comments', 'Verification', 'Home/Away', 'Submitted by', 'Cross-check',
      'Match status', 'Home score', 'Away score', 'Goals & assists (submitting club)', 'Included in digest',
      'Report ID', 'Last corrected', 'Saved form (do not edit)']);
    sh.hideColumns(29);
    sh.getRange('D:D').setNumberFormat('@');      // keep dates as typed so matches line up
    sh.setFrozenRows(1);
    props.setProperty('LOG_SHEET_ID', ss.getId());
  }
  return ss;
}
function getSettings() {
  if (CONFIG.SETTINGS_SHEET_ID) return SpreadsheetApp.openById(CONFIG.SETTINGS_SHEET_ID);
  const props = PropertiesService.getScriptProperties();
  let ss, id = props.getProperty('SETTINGS_SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create('Club Report Settings');
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder());
    const sh = ss.getSheets()[0].setName('Assignors');
    sh.appendRow(['Conference', 'Home team(s), comma-separated (leave blank for whole conference)', 'Assignor email(s) – not used by this form', 'Commissioner email(s), comma-separated']);
    Object.keys(DEFAULT_CLUBS).forEach(c => sh.appendRow([c, '', '', '']));
    sh.setFrozenRows(1); sh.autoResizeColumns(1, 4);
    props.setProperty('SETTINGS_SHEET_ID', ss.getId());
  }
  return ss;
}
function getClubsSheet() {
  const ss = getSettings();
  let sh = ss.getSheetByName('Clubs');
  if (!sh) {
    sh = ss.insertSheet('Clubs');
    sh.appendRow(['Conference', 'Club']);
    const rows = [];
    Object.entries(DEFAULT_CLUBS).forEach(([c, clubs]) => clubs.forEach(club => rows.push([c, club])));
    sh.getRange(2, 1, rows.length, 2).setValues(rows);
    sh.setFrozenRows(1); sh.autoResizeColumns(1, 2);
  }
  return sh;
}
// Commissioner emails only (column D). A home-team row overrides the conference row.
function commissionersFor(conference, home) {
  try {
    const rows = getSettings().getSheetByName('Assignors').getDataRange().getValues().slice(1);
    const norm = s => String(s || '').trim().toLowerCase();
    const teamsIn = cell => String(cell || '').split(/[,;\n]+/).map(key).filter(Boolean);
    const h = key(home);
    const matches = t => t === h || (h.length >= 4 && t.length >= 4 && (t.includes(h) || h.includes(t)));
    const k = key(conference);
    const mine = rows.filter(r => key(r[0]) && k.startsWith(key(r[0])));
    const emails = list => list.map(r => String(r[3] || '')).join(',').split(/[,;\s]+/).filter(isEmail);
    const team = emails(mine.filter(r => teamsIn(r[1]).some(matches)));
    if (team.length) return [...new Set(team)].join(',');
    const filled = mine.filter(r => !norm(r[1]) && emails([r]).length);
    const best = Math.max(0, ...filled.map(r => key(r[0]).length));
    return [...new Set(emails(filled.filter(r => key(r[0]).length === best)))].join(',');
  } catch (e) { console.error(e); return ''; }
}
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '')); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Run once from the editor to grant permissions and create the folder, log and settings sheets.
function setup() {
  getRootFolder(); getLog(); getTotwSheet(); getSettings(); getClubsSheet(); MailApp.getRemainingDailyQuota();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sendDailyDigest').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendDailyDigest').timeBased().atHour(CONFIG.DIGEST_HOUR).everyDays(1).create();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sendTotwDigest').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendTotwDigest').timeBased().onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(12).create();
  if (CONFIG.REF_LOG_SHEET_ID) SpreadsheetApp.openById(CONFIG.REF_LOG_SHEET_ID).getName();   // confirms access to the referee log
}
