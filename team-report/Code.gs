/**
 * APSL Club Post-Match Report – backend (Google Apps Script web app)
 *
 * A short compliance check each club files after a match – the same questions as the conference
 * "APSL Post Match Report" Google Form, with dropdowns for clubs, a validated date and fixed answers.
 *
 * Each submission:
 *   1. Adds a row to the "Club Post-Match Reports" sheet (same column order as the old form's responses)
 *   2. Compares it with the other club's report for the same match and notes any disagreements
 *   3. Emails the league office, copying the conference commissioner (not the referee assignor)
 *   4. Emails the submitter a copy
 *
 * Files in this project: Code.gs (this) and an HTML file named Index (the form page).
 * Deploy: Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 * Updates: Deploy → Manage deployments → pencil → New version (keeps the same link).
 */

const CONFIG = {
  OFFICE_EMAIL: 'sextonaaron12@gmail.com',   // TESTING – change to 'office@apslsoccer.com'
  CC: '',                                    // extra addresses on every report, comma-separated
  ROOT_FOLDER_NAME: 'APSL Club Post-Match Reports',
  // Optional: the referee system's "Referee Report Settings" sheet ID, so both forms share one Clubs list
  // and one commissioner list (Assignors tab, column D). Leave '' to create a separate settings sheet.
  SETTINGS_SHEET_ID: '',
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
    let check;
    try {
      check = compareWithOtherClub(d);
      const ans = k => a[k] + (a[k] === 'No' && notes[k] ? ` – ${notes[k]}` : '');
      logRow([new Date(), d.email, d.division, d.gameDate, d.club, d.opponent, ...CHECKS.map(([k]) => ans(k)),
        d.comments || '', 'I agree', d.side === 'home' ? 'Home' : 'Away', d.name, check.summary]);
    } finally { lock.releaseLock(); }

    const nos = CHECKS.filter(([k]) => a[k] === 'No').map(([k]) => shortLabel(k));
    const tags = [nos.length ? `No: ${nos.join(', ')}` : '', check.disagree ? 'CLUBS DISAGREE' : ''].filter(Boolean);
    const subject = `Club Report – ${d.club} – ${d.home} v ${d.away} (${d.gameDate})` + (tags.length ? ` [${tags.join('] [')}]` : '');
    const html =
      (check.lines.length ? `<div style="border:1px solid ${check.disagree ? '#ec0332' : '#d0d7e5'};background:${check.disagree ? '#fde6eb' : '#f3f6fb'};padding:10px 12px;border-radius:8px;margin:0 0 12px">` +
        `<b>${check.disagree ? 'The two clubs disagree' : 'Other club'}</b><br>${check.lines.map(escapeHtml).join('<br>')}</div>` : '') +
      (d.warnings ? `<p style="background:#fff6db;padding:8px;border-radius:6px"><b>Validator notes:</b> ${escapeHtml(d.warnings)}</p>` : '') +
      `<pre style="font:13px/1.45 Menlo,Consolas,monospace;white-space:pre-wrap">${escapeHtml(d.report)}</pre>`;
    const mail = { to: CONFIG.OFFICE_EMAIL, subject, htmlBody: html, name: 'APSL Club Reports',
      body: (check.lines.length ? check.lines.join('\n') + '\n\n' : '') + d.report };
    if (isEmail(d.email)) mail.replyTo = d.email;
    const cc = [CONFIG.CC, commissionersFor(d.division, d.home)].filter(Boolean).join(',');
    if (cc) mail.cc = cc;
    MailApp.sendEmail(mail);

    if (isEmail(d.email)) MailApp.sendEmail({
      to: d.email, name: 'APSL Club Reports',
      subject: `Received: ${d.club} post-match report – ${d.home} v ${d.away} (${d.gameDate})`,
      body: `Thanks ${d.name} – the APSL office received ${d.club}'s report.\n\nYour report:\n\n${d.report}`,
    });
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  }
}

/* ---------------- compare the two clubs' reports ---------------- */
// Log columns: 0 Timestamp | 1 Email | 2 Conference | 3 Date | 4 Club | 5 Opponent | 6-15 answers | 16 Comments |
//              17 Verification | 18 Home/Away | 19 Name | 20 Other club
function compareWithOtherClub(d) {
  const rows = getLog().getSheets()[0].getDataRange().getValues().slice(1);
  const other = rows.filter(r => isoDay(r[3]) === isoDay(d.gameDate) && sameTeam(r[4], d.opponent) && sameTeam(r[5], d.club)).pop();
  const again = rows.some(r => isoDay(r[3]) === isoDay(d.gameDate) && sameTeam(r[4], d.club) && sameTeam(r[5], d.opponent));
  const lines = [], col = k => 6 + CHECKS.findIndex(([x]) => x === k);
  if (again) lines.push(`Note: ${d.club} already filed a report for this match – this is a resubmission.`);
  if (!other) return { lines, disagree: false, summary: again ? 'Resubmission; other club not in yet' : 'Other club not in yet' };
  const first = s => String(s || '').split(' – ')[0];
  const mine = d.answers || {};
  const diffs = [];
  SHARED.forEach(k => {
    const theirs = first(other[col(k)]), ours = mine[k];
    if (theirs && ours && theirs !== ours && theirs !== 'Unsure' && ours !== 'Unsure') diffs.push(`${shortLabel(k)}: ${d.club} says ${ours}, ${other[4]} says ${theirs}`);
  });
  // our "we gave sub cards" vs their "opponent gave sub cards", and the reverse
  const cross = [[mine.ourCards, first(other[col('oppCards')]), `${d.club}'s sub cards & roster`],
                 [mine.oppCards, first(other[col('ourCards')]), `${other[4]}'s sub cards & roster`]];
  cross.forEach(([x, y, what]) => { if (x && y && x !== y && x !== 'Unsure' && y !== 'Unsure') diffs.push(`${what}: ${d.club} says ${x}, ${other[4]} says ${y}`); });
  if (diffs.length) lines.push(...diffs.map(s => '✗ ' + s));
  else lines.push(`✓ ${other[4]} also reported this match – no disagreements.`);
  return { lines, disagree: diffs.length > 0, summary: diffs.length ? 'DISAGREE – ' + diffs.join(' | ') : 'Agrees with ' + other[4] };
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
      ...CHECKS.map(c => c[1]), 'Other comments', 'Verification', 'Home/Away', 'Submitted by', 'Other club']);
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
function setup() { getRootFolder(); getLog(); getSettings(); getClubsSheet(); MailApp.getRemainingDailyQuota(); }
