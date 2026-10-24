/**
 * APSL Referee Report – backend (Google Apps Script web app)
 *
 * Serves the referee report page (Index.html) and handles each submission:
 *   1. Saves roster photos / supplementals to a Drive folder (one subfolder per game)
 *   2. Appends a row to a "Referee Reports Log" sheet
 *   3. Emails the full report + attachments to the league office, copying the assignor and
 *      commissioner for that conference / home team (from the "Referee Report Settings" sheet)
 *   4. Emails the referee a confirmation
 * Before kickoff, referees save a pre-match checklist (step 1). It goes to the "Pre-match" tab of the
 * log sheet, and the referee gets an emailed link to finish the report (step 2) on any device. If no
 * report arrives REMINDER_AFTER_HOURS after kickoff, sendReminders() (hourly trigger) emails the link again.
 * The form's conference and team dropdowns come from the settings sheet's Clubs tab (Conference | Club).
 *
 * Files in this project: Code.gs (this) and an HTML file named Index (the form page).
 * Deploy: Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 */

const CONFIG = {
  OFFICE_EMAIL: 'sextonaaron12@gmail.com',   // TESTING – change to 'office@apslsoccer.com'
  CC: '',                                    // e.g. 'assignor1@example.com,assignor2@example.com'
  ROOT_FOLDER_NAME: 'APSL Referee Reports',
  MAX_TOTAL_BYTES: 22 * 1024 * 1024,         // Gmail caps attachments at 25 MB
  REMINDER_AFTER_HOURS: 18,                  // one reminder if the report isn't in by then (due within 24h)
  WEB_APP_URL: 'https://aaron-sexton.github.io/apsl-ref-report/',                         // link used in emailed resume links – set to the form's public address
                                             // (e.g. the GitHub Pages page or tinyurl). Blank = this script's /exec link.
  SUPPLEMENTAL_TEMPLATE_NAME: 'Supplemental Referee Report (blank).pdf',   // put this file in the root folder
};

// Serves the referee form. The web app URL is the link you give referees.
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('APSL Referee Report')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);   // lets the league website embed the form
}

// Conferences and their clubs, as of Fall 2026. Used to seed the Clubs tab of the settings sheet;
// after that, edit the Clubs tab (not this list) when clubs join or leave.
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

// Conferences and clubs for the form's dropdowns, from the Clubs tab of the settings sheet.
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
// Blank supplemental form for the page's download button. Reads the PDF named above from the
// "APSL Referee Reports" folder, so you can swap in a new version without touching code.
function getSupplementalTemplate() {
  const files = getRootFolder().getFilesByName(CONFIG.SUPPLEMENTAL_TEMPLATE_NAME);
  if (!files.hasNext()) return { ok: false, error: 'Template not found.' };
  const blob = files.next().getBlob();
  return { ok: true, name: CONFIG.SUPPLEMENTAL_TEMPLATE_NAME, type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
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

// Called by the form page (google.script.run). Takes a JSON string, returns {ok, error?}.
function submitReport(payloadJson) { return handle(JSON.parse(payloadJson)); }

// The page can also be hosted outside Apps Script (e.g. GitHub Pages) and call these by plain POST –
// no Google sign-in involved, so devices with several Google accounts signed in work fine.
const API = { getSetup, submitReport, savePrematch, loadPrematch, getSupplementalTemplate };
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!body.action) return json(handle(body));                               // older pages: plain report payload
    const fn = API[body.action];
    if (!fn) return json({ ok: false, error: 'Unknown action.' });
    return json(fn(...(body.args || [])));
  } catch (err) { console.error(err); return json({ ok: false, error: String(err.message || err) }); }
}

function handle(data) {
  try {
    if (data.website) return { ok: true };                   // honeypot – silently drop bots
    validate(data);

    const root = getRootFolder();
    const f = data.fields;
    const tag = f.gameNo ? clean(f.gameNo) : clean(f.gameDate);
    const folderName = `${f.gameNo ? clean(f.gameNo) + ' · ' : ''}${clean(f.gameDate)} · ${clean(f.home)} v ${clean(f.away)}`;
    const gameFolder = root.createFolder(folderName);

    // Decode and save attachments
    const blobs = (data.files || []).map(file =>
      Utilities.newBlob(Utilities.base64Decode(file.data), file.type || 'application/octet-stream', file.name));
    const total = blobs.reduce((s, b) => s + b.getBytes().length, 0);
    if (total > CONFIG.MAX_TOTAL_BYTES) throw new Error('Attachments are too large (max 22 MB).');
    blobs.forEach(b => gameFolder.createFile(b));
    const reportFile = gameFolder.createFile(`${tag}_report.txt`, data.report, MimeType.PLAIN_TEXT);

    // Log row
    logRow([new Date(), f.gameNo, f.gameDate, f.division, f.home, f.homeScore, f.awayScore, f.away, f.status,
      f.refName, f.refId, f.refEmail, data.supplementalReasons || 'No', data.warnings || '', blobs.length, gameFolder.getUrl()]);

    // Office email
    const flag = data.supplementalReasons ? ` [SUPPLEMENTAL: ${data.supplementalReasons}]` : '';
    const subject = `Ref Report ${f.gameNo ? '#' + f.gameNo + ' ' : ''}– ${f.home} ${f.homeScore}-${f.awayScore} ${f.away} (${f.gameDate})${flag}`;
    const pm = data.prematchId ? markSubmitted(data.prematchId) : null;
    const pmLine = pm ? `Pre-match checklist saved to the league log ${fmt(pm.firstSaved)}` +
      (pm.kickoffMs ? (pm.firstSaved.getTime() <= pm.kickoffMs ? ' (before scheduled kickoff).' : ' – <b>after scheduled kickoff</b>.') : '.')
      : 'Pre-match checklist was <b>not</b> saved to the league log before this report.';
    const html =
      `<p><a href="${gameFolder.getUrl()}">Open this game's folder in Drive</a></p>` +
      `<p style="color:#555">${pmLine}</p>` +
      (data.warnings ? `<p style="background:#fff6db;padding:8px;border-radius:6px"><b>Validator notes:</b> ${escapeHtml(data.warnings)}</p>` : '') +
      `<pre style="font:13px/1.45 Menlo,Consolas,monospace;white-space:pre-wrap">${escapeHtml(data.report)}</pre>`;
    const mail = { to: CONFIG.OFFICE_EMAIL, subject, htmlBody: html, body: data.report, attachments: blobs, name: 'APSL Referee Reports' };
    if (isEmail(f.refEmail)) mail.replyTo = f.refEmail;
    const assignors = assignorsFor(f.division, f.home);
    const cc = [CONFIG.CC, assignors].filter(Boolean).join(',');
    if (cc) mail.cc = cc;
    MailApp.sendEmail(mail);

    // Referee confirmation
    if (isEmail(f.refEmail)) {
      MailApp.sendEmail({
        to: f.refEmail,
        subject: `Received: APSL report – ${f.home} v ${f.away} (${f.gameDate})`,
        body: `Thanks ${f.refName} – the APSL office received your report for ${f.home} v ${f.away} on ${f.gameDate}.\n\n` +
              `If anything needs correcting, email ${CONFIG.OFFICE_EMAIL.includes('apslsoccer') ? CONFIG.OFFICE_EMAIL : 'office@apslsoccer.com'}.\n\n` +
              `Your report:\n\n${data.report}`,
        name: 'APSL Referee Reports',
      });
    }
    return { ok: true, appUrl: appUrl() };
  } catch (err) {
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  }
}

/* ---------------- pre-match checklist (step 1) ---------------- */
// Pre-match tab columns
const PM = { ID: 1, FIRST: 2, LAST: 3, KICKOFF: 4, KICKOFF_MS: 5, CONF: 6, HOME: 7, AWAY: 8, REF: 9, REF_EMAIL: 10,
             PROBLEMS: 11, SUBMITTED: 12, REMINDED: 13, CLIENT_AT: 14, STATE: 15 };
function getPrematchSheet() {
  const ss = getLog();
  let sh = ss.getSheetByName('Pre-match');
  if (!sh) {
    sh = ss.insertSheet('Pre-match');
    sh.appendRow(['ID', 'First saved', 'Last saved', 'Kickoff', 'Kickoff (ms)', 'Conference', 'Home', 'Away', 'Referee',
      'Referee email', 'Checklist problems', 'Report submitted', 'Reminder sent', 'Phone time', 'Saved form (do not edit)']);
    sh.setFrozenRows(1); sh.hideColumns(PM.KICKOFF_MS); sh.hideColumns(PM.STATE);
  }
  return sh;
}
function findPrematchRow(sh, id) {
  if (!id) return 0;
  const ids = sh.getRange(2, PM.ID, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  const i = ids.findIndex(r => String(r[0]) === String(id));
  return i < 0 ? 0 : i + 2;
}
function newId() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = ''; for (let i = 0; i < 8; i++) id += abc[Math.floor(Math.random() * abc.length)];
  return id;
}
// Called by the page when the referee taps "Save checklist & continue".
function savePrematch(payloadJson) {
  const d = JSON.parse(payloadJson), sm = d.summary || {};
  if (!sm.home || !sm.away || !isEmail(sm.refEmail)) return { ok: false, error: 'Missing match or referee details.' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = getPrematchSheet(), now = new Date();
    let row = findPrematchRow(sh, d.id), id = d.id, isNew = !row;
    if (isNew) { id = newId(); row = sh.getLastRow() + 1; sh.getRange(row, PM.ID).setValue(id); sh.getRange(row, PM.FIRST).setValue(now); }
    const vals = [[now, `${sm.gameDate} ${sm.kickoff}`, d.kickoffMs || '', sm.division, sm.home, sm.away, sm.refName, sm.refEmail, sm.problems || 'None']];
    sh.getRange(row, PM.LAST, 1, vals[0].length).setValues(vals);
    sh.getRange(row, PM.CLIENT_AT).setValue(d.clientAt || '');
    sh.getRange(row, PM.STATE).setValue(JSON.stringify(d.state || {}));
    const first = sh.getRange(row, PM.FIRST).getValue();
    if (isNew) MailApp.sendEmail({
      to: sm.refEmail, name: 'APSL Referee Reports',
      subject: `Finish your APSL match report – ${sm.home} v ${sm.away}`,
      body: `Thanks ${sm.refName} – your pre-match checklist for ${sm.home} v ${sm.away} (${sm.gameDate} ${sm.kickoff}) is saved.\n\n` +
            `After the match, finish your report here (works on any phone or computer):\n${resumeLink(id)}\n\n` +
            `Reports are due within 24 hours of the final whistle.`,
    });
    return { ok: true, id, savedAt: new Date(first).toISOString() };
  } finally { lock.releaseLock(); }
}
// Called by the page when opened from a resume link (?r=ID).
function loadPrematch(id) {
  const sh = getPrematchSheet(), row = findPrematchRow(sh, id);
  if (!row) return { ok: false };
  const r = sh.getRange(row, 1, 1, PM.STATE).getValues()[0];
  let state = {}; try { state = JSON.parse(r[PM.STATE - 1] || '{}'); } catch (e) {}
  const iso = v => v instanceof Date ? v.toISOString() : '';
  return { ok: true, state, savedAt: iso(r[PM.FIRST - 1]), clientAt: String(r[PM.CLIENT_AT - 1] || ''), submitted: iso(r[PM.SUBMITTED - 1]) };
}
function markSubmitted(id) {
  const sh = getPrematchSheet(), row = findPrematchRow(sh, id);
  if (!row) return null;
  sh.getRange(row, PM.SUBMITTED).setValue(new Date());
  const r = sh.getRange(row, 1, 1, PM.KICKOFF_MS).getValues()[0];
  return { firstSaved: new Date(r[PM.FIRST - 1]), kickoffMs: Number(r[PM.KICKOFF_MS - 1]) || 0 };
}
// Hourly trigger (installed by setup): one reminder per match if the report isn't in.
function sendReminders() {
  const sh = getPrematchSheet(), n = sh.getLastRow() - 1;
  if (n < 1) return;
  const rows = sh.getRange(2, 1, n, PM.REMINDED).getValues(), now = Date.now();
  rows.forEach((r, i) => {
    const ko = Number(r[PM.KICKOFF_MS - 1]);
    if (!ko || r[PM.SUBMITTED - 1] || r[PM.REMINDED - 1] || !isEmail(r[PM.REF_EMAIL - 1])) return;
    if (now < ko + CONFIG.REMINDER_AFTER_HOURS * 3600e3 || now > ko + 7 * 24 * 3600e3) return;
    MailApp.sendEmail({
      to: r[PM.REF_EMAIL - 1], name: 'APSL Referee Reports',
      subject: `Reminder: match report due – ${r[PM.HOME - 1]} v ${r[PM.AWAY - 1]}`,
      body: `Hi ${r[PM.REF - 1]} – we haven't received your match report for ${r[PM.HOME - 1]} v ${r[PM.AWAY - 1]} (${r[PM.KICKOFF - 1]}). ` +
            `Reports are due within 24 hours of the final whistle.\n\nFinish it here – your pre-match checklist is already filled in:\n${resumeLink(r[PM.ID - 1])}`,
    });
    sh.getRange(i + 2, PM.REMINDED).setValue(new Date());
  });
}
function appUrl() {
  // Workspace accounts return /a/macros/<domain>/… links that can ask outside referees to sign in; use the public form.
  return CONFIG.WEB_APP_URL || ScriptApp.getService().getUrl().replace(/\/a\/macros\/[^/]+\//, '/macros/');
}
function resumeLink(id) { return `${appUrl()}?r=${encodeURIComponent(id)}`; }
function fmt(d) { return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'EEE MMM d, h:mm a z'); }

/* ---------------- helpers ---------------- */
function validate(d) {
  const f = d && d.fields;
  if (!f) throw new Error('Missing report fields.');
  ['gameDate', 'home', 'away', 'refName', 'refEmail'].forEach(k => {
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
    ss = SpreadsheetApp.create('Referee Reports Log');
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder());
    ss.getSheets()[0].appendRow(['Received', 'Game #', 'Date', 'Division', 'Home', 'H', 'A', 'Away', 'Status',
      'Referee', 'USSF ID', 'Ref email', 'Supplemental', 'Validator notes', 'Files', 'Folder']);
    ss.getSheets()[0].setFrozenRows(1);
    props.setProperty('LOG_SHEET_ID', ss.getId());
  }
  return ss;
}
// "Referee Report Settings" sheet → Assignors tab:
//   Conference | Home team(s), comma-separated (blank = whole conference) | Assignor email(s) | Commissioner email(s)
function getSettings() {
  const props = PropertiesService.getScriptProperties();
  let ss, id = props.getProperty('SETTINGS_SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create('Referee Report Settings');
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder());
    const sh = ss.getSheets()[0].setName('Assignors');
    sh.appendRow(['Conference', 'Home team(s), comma-separated (leave blank for whole conference)', 'Assignor email(s), comma-separated', 'Commissioner email(s), comma-separated']);
    Object.keys(DEFAULT_CLUBS).forEach(c => sh.appendRow([c, '', '', '']));
    sh.setFrozenRows(1); sh.autoResizeColumns(1, 4);
    props.setProperty('SETTINGS_SHEET_ID', ss.getId());
  }
  return ss;
}
// Assignor + commissioner emails for a report. A home-team row overrides the conference row for that column.
function assignorsFor(conference, home) {
  try {
    const rows = getSettings().getSheetByName('Assignors').getDataRange().getValues().slice(1);
    const norm = s => String(s || '').trim().toLowerCase();
    const key = s => norm(s).replace(/[^a-z0-9]+/g, '');        // ignore spaces, punctuation, case
    const teamsIn = cell => String(cell || '').split(/[,;\n]+/).map(key).filter(Boolean);
    const h = key(home);
    // Column B may list several teams, comma-separated. A team matches if the names are the same, or one
    // contains the other (so a ref typing "Hoboken" still matches "Hoboken FC 1912").
    const matches = t => t === h || (h.length >= 4 && t.length >= 4 && (t.includes(h) || h.includes(t)));
    // A row's conference applies if it is the report's conference or the start of it, so one row for
    // "Mid-Atlantic Conference" covers both Chesapeake and Old Dominion. The most specific conference row wins.
    const k = key(conference);
    const mine = rows.filter(r => key(r[0]) && k.startsWith(key(r[0])));
    const team = mine.filter(r => teamsIn(r[1]).some(matches));
    const confRows = mine.filter(r => !norm(r[1]));
    const emails = (list, i) => list.map(r => String(r[i] || '')).join(',').split(/[,;\s]+/).filter(isEmail);
    // Per column: a matching team row wins; otherwise the most specific conference row that has an email there.
    const forCol = i => {
      const t = emails(team, i); if (t.length) return t;
      const filled = confRows.filter(r => emails([r], i).length);
      const best = Math.max(0, ...filled.map(r => key(r[0]).length));
      return emails(filled.filter(r => key(r[0]).length === best), i);
    };
    return [...new Set([...forCol(2), ...forCol(3)])].join(',');
  } catch (e) { console.error(e); return ''; }
}
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function clean(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim(); }
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '')); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Run once from the editor to grant permissions and create the Drive folder + log sheet.
function setup() {
  getRootFolder(); getLog(); getPrematchSheet(); getSettings(); getClubsSheet(); MailApp.getRemainingDailyQuota();
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendReminders'))
    ScriptApp.newTrigger('sendReminders').timeBased().everyHours(1).create();
}
