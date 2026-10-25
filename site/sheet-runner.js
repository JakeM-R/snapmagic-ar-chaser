/* ===== Sheet runner (Google Apps Script) =====
 * Everything above this line is the same AR core the web page runs, so the Sheet gets
 * identical aging, tiers, modifiers and templates.
 *
 * Script properties (Project Settings > Script properties):
 *   SLACK_WEBHOOK_URL  Slack incoming webhook for the digest (optional)
 *   SENDER_NAME, SENDER_ROLE    sign-off for tiers 1 to 3
 *   FOUNDER_NAME, FOUNDER_ROLE  sign-off for tier 4
 *   SHEET_NAME         tab holding the invoice export (default "Invoices")
 *   COLUMN_MAP         optional JSON override, e.g. {"customer":"Client","dueDate":"Due"}
 *
 * Each run replaces the drafts the previous run saved and you didn't send, so old figures
 * never pile up in Gmail. It keeps their ids in the DRAFT_IDS script property.
 */

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "run") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("run").timeBased().everyWeeks(2).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
}

function run() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(props.SHEET_NAME || "Invoices");
  if (!sheet) throw new Error("No tab named " + (props.SHEET_NAME || "Invoices"));

  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = values.slice(1).map(function (r) {
    var o = {};
    headers.forEach(function (h, j) { o[h] = r[j] instanceof Date ? r[j] : (r[j] == null ? "" : String(r[j])); });
    return o;
  });

  var map = AR.autoMap(headers);
  if (props.COLUMN_MAP) Object.assign(map, JSON.parse(props.COLUMN_MAP));
  var missing = AR.missingRequired(map);
  if (missing.length) throw new Error("Map these columns in COLUMN_MAP: " + missing.join(", "));

  var now = new Date();
  var runDate = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  var settings = {};
  if (props.SENDER_NAME) settings.senderName = props.SENDER_NAME;
  if (props.SENDER_ROLE) settings.senderRole = props.SENDER_ROLE;
  if (props.FOUNDER_NAME) settings.founderName = props.FOUNDER_NAME;
  if (props.FOUNDER_ROLE) settings.founderRole = props.FOUNDER_ROLE;

  var res = AR.analyze(rows, map, runDate, settings);
  var store = PropertiesService.getScriptProperties();
  var previous = JSON.parse(props.DRAFT_IDS || "[]");
  previous.forEach(function (id) {
    // Gone already if it was sent or deleted by hand; that's fine.
    try { GmailApp.getDraft(id).deleteDraft(); } catch (e) { /* not there */ }
  });
  var drafted = 0, ids = [];
  res.customers.forEach(function (c) {
    var d = AR.templateDraft(c, runDate, res.settings);
    if (!d.body || !d.to) return;
    var opts = d.cc ? { cc: d.cc } : {};
    ids.push(GmailApp.createDraft(d.to, d.subject, d.body, opts).getId());
    drafted++;
  });
  store.setProperty("DRAFT_IDS", JSON.stringify(ids));

  var digest = AR.slackDigest(res);
  if (props.SLACK_WEBHOOK_URL) {
    UrlFetchApp.fetch(props.SLACK_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ text: digest })
    });
  }

  var log = ss.getSheetByName("AR runs") || ss.insertSheet("AR runs");
  if (log.getLastRow() === 0) log.appendRow(["Run date", "Outstanding", "Over 30 days", "Customers to chase", "Drafts saved", "Rows excluded"]);
  log.appendRow([AR.isoDate(runDate), res.totalAR, res.over30, res.toChase, drafted, res.excludedTotal]);
  return digest;
}
