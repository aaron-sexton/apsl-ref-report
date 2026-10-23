/**
 * APSL Referee Report – backend (Google Apps Script web app)
 *
 * Serves the referee report page (Index.html) and handles each submission:
 *   1. Saves roster photos / supplementals to a Drive folder (one subfolder per game)
 *   2. Appends a row to a "Referee Reports Log" sheet
 *   3. Emails the full report + attachments to the league office, copying the assignor and
 *      commissioner for that conference / home team (from the "Referee Report Settings" sheet)
 *   4. Emails the referee a confirmation
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
};

// Serves the referee form. The web app URL is the link you give referees.
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('APSL Referee Report')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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

// Still accepts POSTs, so a copy of the page hosted elsewhere (e.g. GitHub Pages) also works.
function doPost(e) { return json(handle(JSON.parse(e.postData.contents))); }

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
    const html =
      `<p><a href="${gameFolder.getUrl()}">Open this game's folder in Drive</a></p>` +
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
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  }
}

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
function setup() { getRootFolder(); getLog(); getSettings(); getClubsSheet(); MailApp.getRemainingDailyQuota(); }
