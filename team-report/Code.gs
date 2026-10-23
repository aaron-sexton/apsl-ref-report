/**
 * APSL Team Match Report – backend (Google Apps Script web app)
 *
 * A club-side companion to the Referee Match Report. A manager or club official from either team
 * submits the result, their scorers, cards, subs, roster photo and any incident statement.
 *
 * Each submission:
 *   1. Saves photos/files to a Drive folder (one folder per match, shared by both clubs' reports)
 *   2. Appends a row to the "Team Reports Log" sheet
 *   3. Cross-checks the result against the other club's report and the referee's report for the
 *      same match (from the Referee Reports Log), and flags any mismatch
 *   4. Emails the report to the league office, copying the conference commissioner (never the referee assignor)
 *   5. Emails the submitter a confirmation
 *
 * Files in this project: Code.gs (this) and an HTML file named Index (the form page).
 * Deploy: Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 * Updates: Deploy → Manage deployments → pencil → New version (keeps the same link).
 */

const CONFIG = {
  OFFICE_EMAIL: 'sextonaaron12@gmail.com',   // TESTING – change to 'office@apslsoccer.com'
  CC: '',                                    // extra addresses on every report, comma-separated
  ROOT_FOLDER_NAME: 'APSL Team Match Reports',
  MAX_TOTAL_BYTES: 22 * 1024 * 1024,         // Gmail caps attachments at 25 MB
  // The referee system's "Referee Reports Log" – used to cross-check scores. Leave '' to skip.
  REF_LOG_SHEET_ID: '1mPYPz7ed7K1qHDAjkNWe4mDNpLeT1cVOBH3eAs1el34',
  // Optional: the referee system's "Referee Report Settings" sheet ID, so both forms share one
  // Clubs list and one Assignors/Commissioners list. Leave '' to create a separate settings sheet.
  SETTINGS_SHEET_ID: '',
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('APSL Team Match Report')
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

// Conferences and clubs for the form's dropdowns.
function getSetup() {
  const rows = getClubsSheet().getDataRange().getValues().slice(1);
  const map = {};
  rows.forEach(r => {
    const c = String(r[0] || '').trim(), club = String(r[1] || '').trim();
    if (!c) return;
    (map[c] = map[c] || []);
    if (club && !map[c].includes(club)) map[c].push(club);
  });
  return { conferences: Object.keys(map).map(name => ({ name, clubs: map[name].sort((a, b) => a.localeCompare(b)) })) };
}

// Called by the form page (google.script.run). Takes a JSON string, returns {ok, error?}.
function submitReport(payloadJson) { return handle(JSON.parse(payloadJson)); }
function doPost(e) { return json(handle(JSON.parse(e.postData.contents))); }

function handle(data) {
  try {
    if (data.website) return { ok: true };                   // honeypot – silently drop bots
    validate(data);
    const f = data.fields;
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    let check, gameFolder, blobs;
    try {
      // Cross-check BEFORE logging this report, so it only compares against earlier ones.
      check = crossCheck(f);

      // One Drive folder per match, shared by both clubs' reports
      const root = getRootFolder();
      const folderName = `${clean(f.gameDate)} · ${clean(f.home)} v ${clean(f.away)}`;
      const existing = root.getFoldersByName(folderName);
      gameFolder = existing.hasNext() ? existing.next() : root.createFolder(folderName);

      blobs = (data.files || []).map(file =>
        Utilities.newBlob(Utilities.base64Decode(file.data), file.type || 'application/octet-stream', file.name));
      const total = blobs.reduce((s, b) => s + b.getBytes().length, 0);
      if (total > CONFIG.MAX_TOTAL_BYTES) throw new Error('Attachments are too large (max 22 MB).');
      blobs.forEach(b => gameFolder.createFile(b));
      gameFolder.createFile(`${clean(f.gameDate)}_${clean(f.team)}_team-report.txt`, data.report, MimeType.PLAIN_TEXT);

      logRow([new Date(), f.gameDate, f.division, f.home, f.homeScore, f.awayScore, f.away, f.status,
        f.side === 'home' ? 'Home' : 'Away', f.team, f.refName, f.refRole, f.refEmail, f.officialRef || '',
        data.statementReasons || 'No', check.summary, gameFolder.getUrl()]);
    } finally { lock.releaseLock(); }

    // Office email
    const tags = [check.mismatch ? 'SCORE MISMATCH' : '', data.statementReasons ? `STATEMENT: ${data.statementReasons}` : '',
                  data.protest ? 'PROTEST' : ''].filter(Boolean);
    const subject = `Team Report – ${f.team} (${f.side}) – ${f.home} ${f.homeScore}-${f.awayScore} ${f.away} (${f.gameDate})` +
      (tags.length ? ` [${tags.join('] [')}]` : '');
    const html =
      `<p><a href="${gameFolder.getUrl()}">Open this match's folder in Drive</a></p>` +
      `<div style="border:1px solid ${check.mismatch ? '#ec0332' : '#d0d7e5'};background:${check.mismatch ? '#fde6eb' : '#f3f6fb'};padding:10px 12px;border-radius:8px;margin:0 0 12px">` +
      `<b>${check.mismatch ? 'Score mismatch – please review' : 'Cross-check'}</b><br>${check.lines.map(escapeHtml).join('<br>')}</div>` +
      (data.warnings ? `<p style="background:#fff6db;padding:8px;border-radius:6px"><b>Validator notes:</b> ${escapeHtml(data.warnings)}</p>` : '') +
      `<pre style="font:13px/1.45 Menlo,Consolas,monospace;white-space:pre-wrap">${escapeHtml(data.report)}</pre>`;
    const mail = { to: CONFIG.OFFICE_EMAIL, subject, htmlBody: html,
      body: `CROSS-CHECK\n${check.lines.join('\n')}\n\n${data.report}`, attachments: blobs, name: 'APSL Team Match Reports' };
    if (isEmail(f.refEmail)) mail.replyTo = f.refEmail;
    const cc = [CONFIG.CC, recipientsFor(f.division, f.home)].filter(Boolean).join(',');
    if (cc) mail.cc = cc;
    MailApp.sendEmail(mail);

    if (isEmail(f.refEmail)) MailApp.sendEmail({
      to: f.refEmail, name: 'APSL Team Match Reports',
      subject: `Received: ${f.team} team report – ${f.home} v ${f.away} (${f.gameDate})`,
      body: `Thanks ${f.refName} – the APSL office received ${f.team}'s report for ${f.home} v ${f.away} on ${f.gameDate}.\n\n` +
            `If anything needs correcting, reply to the league office at office@apslsoccer.com.\n\nYour report:\n\n${data.report}`,
    });
    return { ok: true, mismatch: check.mismatch };
  } catch (err) {
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  }
}

/* ---------------- cross-check ---------------- */
// Compares this report's result with (a) earlier reports from either club for the same match and
// (b) the referee's report in the Referee Reports Log. Same match = same date + same home & away teams.
function crossCheck(f) {
  const lines = [], mine = scoreOf(f.homeScore, f.awayScore, f.statusCode);
  let mismatch = false, found = 0;
  const same = (d, h, a) => isoDay(d) === isoDay(f.gameDate) && sameTeam(h, f.home) && sameTeam(a, f.away);
  const compare = (who, when, h, a, status) => {
    found++;
    const theirs = scoreOf(h, a, status), agree = theirs === mine;
    if (!agree) mismatch = true;
    lines.push(`${agree ? '✓' : '✗'} ${who} (${fmt(when)}): ${f.home} ${theirs} ${f.away}${agree ? ' – matches' : ` – this report says ${mine}`}`);
  };
  // other club reports (Team Reports Log): Received|Date|Conference|Home|H|A|Away|Status|Side|Club|...
  try {
    const rows = getLog().getSheets()[0].getDataRange().getValues().slice(1);
    rows.filter(r => same(r[1], r[3], r[6])).forEach(r => {
      const own = String(r[8]).toLowerCase() === f.side;
      compare(own ? `Earlier ${r[9]} report (same club – resubmission?)` : `${r[9]} report`, r[0], r[4], r[5], r[7]);
    });
  } catch (e) { console.error(e); }
  // referee report (Referee Reports Log): Received|Game #|Date|Division|Home|H|A|Away|Status|Referee|...
  let refFound = false;
  if (CONFIG.REF_LOG_SHEET_ID) {
    try {
      const rows = SpreadsheetApp.openById(CONFIG.REF_LOG_SHEET_ID).getSheets()[0].getDataRange().getValues().slice(1);
      rows.filter(r => same(r[2], r[4], r[7])).forEach(r => { refFound = true; compare(`Referee report – ${r[9] || 'referee'}`, r[0], r[5], r[6], r[8]); });
    } catch (e) { lines.push('Referee log could not be read – check REF_LOG_SHEET_ID.'); }
    if (!refFound) lines.push('Referee report: not received yet.');
  }
  if (!found) lines.push(`No other reports for this match yet. This report: ${f.home} ${mine} ${f.away}.`);
  const summary = mismatch ? 'MISMATCH – ' + lines.filter(l => l.startsWith('✗')).join(' | ') : found ? 'Matches ' + found + ' other report(s)' : 'First report';
  return { lines, mismatch, summary };
}
function scoreOf(h, a, status) {
  const st = String(status || '');
  if (/^not played/i.test(st)) return 'not played';
  if (/^forfeit/i.test(st)) return 'forfeit';
  return `${h === '' || h == null ? '?' : Number(h)}-${a === '' || a == null ? '?' : Number(a)}`;
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
function fmt(d) { try { return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'MMM d, h:mm a'); } catch (e) { return ''; } }

/* ---------------- storage ---------------- */
function validate(d) {
  const f = d && d.fields;
  if (!f) throw new Error('Missing report fields.');
  ['gameDate', 'home', 'away', 'side', 'team', 'refName', 'refEmail'].forEach(k => {
    if (!f[k] || !String(f[k]).trim()) throw new Error(`Missing ${k}.`);
  });
  if (!d.report) throw new Error('Missing report text.');
}
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
    ss = SpreadsheetApp.create('Team Reports Log');
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder());
    const sh = ss.getSheets()[0];
    sh.appendRow(['Received', 'Date', 'Conference', 'Home', 'H', 'A', 'Away', 'Status', 'Submitted for', 'Club',
      'Submitted by', 'Role', 'Email', 'Referee (per club)', 'Statement', 'Cross-check', 'Folder']);
    sh.getRange('B:B').setNumberFormat('@');      // keep dates as typed so cross-checks match exactly
    sh.setFrozenRows(1);
    props.setProperty('LOG_SHEET_ID', ss.getId());
  }
  return ss;
}
// Settings: Assignors tab (Conference | Home team(s) | Assignor email(s) | Commissioner email(s)) + Clubs tab.
// Point CONFIG.SETTINGS_SHEET_ID at the referee system's settings sheet to share one list.
function getSettings() {
  if (CONFIG.SETTINGS_SHEET_ID) return SpreadsheetApp.openById(CONFIG.SETTINGS_SHEET_ID);
  const props = PropertiesService.getScriptProperties();
  let ss, id = props.getProperty('SETTINGS_SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create('Team Report Settings');
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder());
    const sh = ss.getSheets()[0].setName('Assignors');
    sh.appendRow(['Conference', 'Home team(s), comma-separated (leave blank for whole conference)', 'Assignor email(s), comma-separated', 'Commissioner email(s), comma-separated']);
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
// Commissioner emails only (column D) – club reports are not sent to referee assignors.
// Same matching rules as the referee form: a home-team row overrides the conference row.
function recipientsFor(conference, home) {
  try {
    const rows = getSettings().getSheetByName('Assignors').getDataRange().getValues().slice(1);
    const norm = s => String(s || '').trim().toLowerCase();
    const teamsIn = cell => String(cell || '').split(/[,;\n]+/).map(key).filter(Boolean);
    const h = key(home);
    const matches = t => t === h || (h.length >= 4 && t.length >= 4 && (t.includes(h) || h.includes(t)));
    const k = key(conference);
    const mine = rows.filter(r => key(r[0]) && k.startsWith(key(r[0])));
    const team = mine.filter(r => teamsIn(r[1]).some(matches));
    const confRows = mine.filter(r => !norm(r[1]));
    const emails = (list, i) => list.map(r => String(r[i] || '')).join(',').split(/[,;\s]+/).filter(isEmail);
    const forCol = i => {
      const t = emails(team, i); if (t.length) return t;
      const filled = confRows.filter(r => emails([r], i).length);
      const best = Math.max(0, ...filled.map(r => key(r[0]).length));
      return emails(filled.filter(r => key(r[0]).length === best), i);
    };
    return [...new Set(forCol(3))].join(',');
  } catch (e) { console.error(e); return ''; }
}
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function clean(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim(); }
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '')); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Run once from the editor to grant permissions and create the Drive folder, log and settings sheets.
function setup() {
  getRootFolder(); getLog(); getSettings(); getClubsSheet(); MailApp.getRemainingDailyQuota();
  if (CONFIG.REF_LOG_SHEET_ID) SpreadsheetApp.openById(CONFIG.REF_LOG_SHEET_ID).getName();   // confirms access to the referee log
}
