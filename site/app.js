/* AR chaser UI. All parsing and aging happens here in the browser via ar.js. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var DAY = 86400000;
  var WORKER_URL = (document.querySelector('meta[name="worker-url"]') || {}).content || "";

  var BUCKET_VARS = { current: "--b-current", b1: "--b-1", b31: "--b-31", b61: "--b-61", b90: "--b-90" };
  var TIER_COLORS = ["#6B7A90", "#8A6510", "#B85A1C", "#9A4422", "#34507A", "#34507A"];

  var state = {
    source: "demo", fileName: "", rows: [], headers: [], map: {},
    ticks: {}, sort: { aging: "overdue", drafts: "overdue" }, onlyYou: { aging: false, drafts: false }, tab: "demo", runDate: todayUTC(), settings: Object.assign({}, AR.DEFAULT_SETTINGS),
    result: null, drafts: {}, dirty: {}, open: {}, draftMode: "template", runId: 0,
    stage: "bill", billed: null,
    bill: { source: "demo", fileName: "", rows: [], headers: [], map: {}, period: null, run: null, emails: {}, dirty: {}, open: {}, pending: null }
  };
  state.bill.period = BILL.periodOf(todayUTC()).start;

  // Invoices sent over from the billing run, laid out in the current AR file's own columns.
  function billedRows() {
    if (!state.billed) return [];
    var m = state.map;
    return state.billed.records.map(function (rec) {
      var o = {};
      Object.keys(rec).forEach(function (k) { if (m[k]) o[m[k]] = rec[k]; });
      if (m.balance && !m.paid) o[m.balance] = rec.amount;
      return o;
    });
  }
  function allRows() { return state.rows.concat(billedRows()); }

  function todayUTC() { var d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function isDemo() { return state.source === "demo"; }
  // Demo mode shows every dollar figure as $xx; an uploaded file shows real amounts.
  var MONEY_RE = /-?\$\s?[0-9][0-9,]*(?:\.[0-9]+)?k?/g;
  function mask(text) { return isDemo() ? String(text).replace(MONEY_RE, "$$xx") : String(text); }
  function money(n) { return isDemo() ? "$xx" : AR.fmtMoney(Math.round(n)); }
  function kMoney(n) { return isDemo() ? "$xx" : AR.fmtK(n); }
  function maskDraft(d) { if (isDemo()) { d.subject = mask(d.subject); d.body = mask(d.body); } return d; }

  // ---------- Data loading ----------

  function loadDemo() {
    var p = AR.parseCSV(DEMO.csv(todayUTC()));
    state.source = "demo"; state.fileName = "";
    state.headers = p.headers; state.rows = p.rows; state.map = AR.autoMap(p.headers);
    $("mapper").innerHTML = "";
    runAnalysis();
  }

  // ---------- Tabs ----------

  function setTab(tab) {
    state.tab = tab;
    $("tabDemo").setAttribute("aria-selected", tab === "demo");
    $("tabUpload").setAttribute("aria-selected", tab === "upload");
    $("uploadPanel").hidden = tab !== "upload";
    $("script").hidden = tab !== "upload";
    if (tab === "demo") {
      $("results").hidden = false;
      if (!isDemo()) loadDemo();
    } else {
      renderUploadHead();
      // Results show only once a file of the user's own has been run.
      $("results").hidden = isDemo();
      $("guide").open = isDemo();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function renderUploadHead() {
    if (!isDemo()) {
      $("uploadHead").innerHTML = '<div class="loaded"><span>Showing <b>' + esc(state.fileName) + "</b> · " + state.rows.length + " rows</span>" +
        '<span class="spacer"></span><label for="file" class="btn" tabindex="0" data-pick>Choose another file</label></div>';
      return;
    }
    $("uploadHead").innerHTML = '<div class="drop" id="drop"><h3>Upload your invoice export</h3>' +
      "<p>CSV from HubSpot or QuickBooks. It's read in this browser and never uploaded anywhere.</p>" +
      '<div class="row"><label for="file" class="btn primary" tabindex="0" data-pick>Choose CSV</label>' +
      '<button class="btn" type="button" id="tplBtn">Download template</button></div></div>';
    var drop = $("drop");
    ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
    drop.addEventListener("drop", function (e) { var f = e.dataTransfer.files[0]; if (f) loadFile(f); });
    $("tplBtn").addEventListener("click", downloadTemplate);
  }

  // One header name per column, the same as the template. Other common names are matched automatically.
  var GUIDE_HEADERS = { invoice: "Invoice number", customer: "Company name", email: "Contact email", ccEmail: "AP email",
    amount: "Amount", paid: "Amount paid", balance: "Open balance", issueDate: "Invoice date", dueDate: "Due date",
    status: "Status", terms: "Terms", paidDate: "Paid date", lastContacted: "Last contacted" };

  function renderGuide() {
    var need = function (f) {
      return f.required ? '<span class="need req">Required</span>' : f.recommended ? '<span class="need rec">Recommended</span>' : '<span class="need opt">Optional</span>';
    };
    $("guideTable").innerHTML = "<table><thead><tr><th>Column</th><th></th><th>What it's used for</th></tr></thead><tbody>" +
      AR.FIELDS.map(function (f) {
        return '<tr><td class="f">' + esc(GUIDE_HEADERS[f.key]) + "</td><td>" + need(f) + '</td><td class="u">' + esc(f.use) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function downloadTemplate() {
    var lines = [
      "Invoice number,Company name,Contact email,AP email,Amount,Amount paid,Invoice date,Due date,Status,Terms,Paid date,Last contacted",
      "DEMO-001,Customer A,billing@customer-a.example,,1000.00,0.00,2026-09-01,2026-10-01,Open,Net 30,,2026-10-08",
      "DEMO-002,Customer A,billing@customer-a.example,,500.00,500.00,2026-07-01,2026-07-31,Paid,Net 30,2026-08-05,"
    ];
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    a.download = "ar-chaser-template.csv"; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function loadFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var p = AR.parseCSV(reader.result);
      if (state.tab !== "upload") setTab("upload");
      if (!p.headers.length || !p.rows.length) { showMapperError("That file has no rows."); return; }
      state.pending = { headers: p.headers, rows: p.rows, name: file.name };
      renderMapper(p.headers, AR.autoMap(p.headers), file.name, p.rows.length);
    };
    reader.readAsText(file);
  }

  function showMapperError(msg) {
    $("mapper").innerHTML = '<div class="mapper"><p class="err">' + esc(msg) + "</p></div>";
  }

  function renderMapper(headers, map, name, n) {
    var opts = function (sel) {
      return '<option value="">Not in file</option>' + headers.map(function (h) {
        return '<option value="' + esc(h) + '"' + (h === sel ? " selected" : "") + ">" + esc(h) + "</option>";
      }).join("");
    };
    $("mapper").innerHTML =
      '<div class="mapper"><h3>Match columns: ' + esc(name) + "</h3>" +
      "<p>" + n + " rows. Matched from your headers; check anything marked required. The guide below says what each column does.</p>" +
      '<div class="mapgrid">' + AR.FIELDS.map(function (f) {
        return "<label>" + esc(f.label) + (f.required ? ' <span class="req">required</span>' : "") +
          '<select data-k="' + f.key + '">' + opts(map[f.key]) + "</select></label>";
      }).join("") + "</div>" +
      '<div class="actions"><button class="btn primary" id="applyMap" type="button">Run aging</button>' +
      '<button class="btn ghost" id="cancelMap" type="button">Cancel</button><span class="err" id="mapErr"></span></div></div>';
    $("applyMap").onclick = function () {
      var m = {};
      document.querySelectorAll("#mapper select").forEach(function (s) { if (s.value) m[s.dataset.k] = s.value; });
      var miss = AR.missingRequired(m);
      if (miss.length) { $("mapErr").textContent = "Still needed: " + miss.join(", "); return; }
      state.source = "file"; state.fileName = state.pending.name;
      state.headers = state.pending.headers; state.rows = state.pending.rows; state.map = m;
      $("mapper").innerHTML = "";
      runAnalysis();
      renderUploadHead();
      $("results").hidden = false;
      $("guide").open = false;
      $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    $("cancelMap").onclick = function () { $("mapper").innerHTML = ""; };
    $("mapper").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- Run ----------

  // ---------- Actioned ticks ----------
  // Per-viewer convenience kept in this browser only. A tick clears Needs action and logs
  // the run date as the last contact.
  function tickKey(c) { return "arc:actioned:" + (isDemo() ? "demo" : state.fileName) + ":" + c.name; }
  function readTick(c) { try { return localStorage.getItem(tickKey(c)); } catch (e) { return state.ticks[tickKey(c)] || null; } }
  function writeTick(c, val) {
    state.ticks[tickKey(c)] = val;
    try { if (val) localStorage.setItem(tickKey(c), val); else localStorage.removeItem(tickKey(c)); } catch (e) { /* memory only */ }
  }
  function applyTicks(res) {
    res.customers.forEach(function (c) {
      if (c.flaggedNeeds == null) { c.flaggedNeeds = c.needsYou; c.importedContact = c.lastContacted; }
      var t = readTick(c);
      c.actioned = !!t && c.tier >= 1;
      c.needsYou = c.flaggedNeeds && !c.actioned;
      c.lastContacted = c.actioned ? Math.max(AR.parseDate(t), c.importedContact || 0) : c.importedContact;
    });
  }
  function contactText(c) {
    if (c.lastContacted == null) return "No contact logged";
    var d = Math.round((state.runDate - c.lastContacted) / DAY);
    return "Last contacted " + AR.fmtShortDate(c.lastContacted) + (d === 0 ? " (today)" : " (" + d + (d === 1 ? " day" : " days") + " ago)");
  }

  function runAnalysis() {
    state.result = AR.analyze(allRows(), state.map, state.runDate, state.settings);
    applyTicks(state.result);
    state.drafts = {}; state.dirty = {}; state.draftMode = "template";
    state.result.customers.forEach(function (c, i) { c.id = i; state.drafts[i] = maskDraft(AR.templateDraft(c, state.runDate, state.settings)); });
    render();
    requestModelDrafts();
  }

  function requestModelDrafts() {
    var res = state.result;
    var targets = res.customers.filter(function (c) { return c.action === "chase" || c.action === "billing"; });
    if (!WORKER_URL) { setStatus("", "Drafts from fixed templates per tier."); return; }
    if (!targets.length) { setStatus("", "Nothing to draft this run"); return; }
    var runId = ++state.runId;
    setStatus("busy", "Drafting with AI… templates shown meanwhile");
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 45000);
    fetch(WORKER_URL, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ customers: targets.slice(0, 15).map(function (c) { return AR.modelSummary(c, state.runDate, state.settings); }) })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      clearTimeout(timer);
      if (runId !== state.runId) return;
      var used = 0, rejected = 0;
      (data.drafts || []).forEach(function (d) {
        var c = targets[d.index];
        if (!c || state.dirty[c.id]) return;
        var chosen = AR.chooseDraft(d, c, state.runDate, state.settings);
        if (chosen.source === "claude") used++; else rejected++;
        state.drafts[c.id] = maskDraft(chosen);
      });
      state.draftMode = "claude";
      renderCards();
      setStatus("ok", "Drafted by AI: " + used + (rejected ? " · " + rejected + " fell back to template after failing a rule check" : "") + ". Every draft is checked against the rules before it's shown.");
    }).catch(function () {
      clearTimeout(timer);
      if (runId !== state.runId) return;
      setStatus("", "AI drafting unavailable right now, so these are the fixed templates per tier");
    });
  }

  function setStatus(cls, text) {
    var el = $("draftStatus");
    el.className = "status " + cls;
    el.lastElementChild.textContent = text;
  }

  // ---------- Render ----------

  function render() {
    var res = state.result;
    var pill = $("dataPill");
    pill.className = "pill " + (isDemo() ? "demo" : "file");
    pill.textContent = isDemo() ? "Demo data" : state.fileName;
    pill.title = isDemo() ? "Fictional customers and figures" : "Your file, processed in this browser";

    $("runDate").value = AR.isoDate(state.runDate);
    $("nextRun").textContent = "Next run " + AR.fmtDate(res.nextRun);

    var n = res.toChase;
    $("headline").innerHTML = n + " customer" + (n === 1 ? "" : "s") + " to chase" +
      '<span class="sep">·</span><small>' + kMoney(res.totalAR) + " outstanding</small>" +
      '<span class="sep">·</span><small>' + kMoney(res.over30) + " over 30 days</small>";
    $("dates").innerHTML = "Run <b>" + esc(AR.fmtDate(res.runDate)) + "</b><br>Next run <b>" + esc(AR.fmtDate(res.nextRun)) + "</b>";

    var needs = res.customers.filter(function (c) { return c.needsYou; });
    var chase = res.customers.filter(function (c) { return c.action === "chase"; }).length;
    var billing = res.customers.filter(function (c) { return c.action === "billing"; }).length;
    var co = [];
    if (needs.length) co.push('<span class="callout you"><b>' + needs.length + " need action</b>: " + needs.map(function (c) { return esc(c.name); }).join(", ") + "</span>");
    co.push('<span class="callout"><b>' + chase + "</b> chaser draft" + (chase === 1 ? "" : "s") + " ready</span>");
    if (billing) co.push('<span class="callout"><b>' + billing + "</b> billing repl" + (billing === 1 ? "y" : "ies") + "</span>");
    if (res.excludedTotal) co.push('<span class="callout"><b>' + res.excludedTotal + "</b> rows excluded</span>");
    if (state.billed) {
      var b = state.billed;
      co.push('<span class="callout"><b>' + b.count + "</b> invoice" + (b.count === 1 ? "" : "s") + " from the " + esc(b.label) + " billing run included, due " + esc(AR.fmtShortDate(b.firstDue)) +
        (b.demo && !isDemo() ? " (demo invoices in your file)" : "") + '<button class="link" type="button" id="unbill">Remove</button></span>');
    }
    $("callouts").innerHTML = co.join("");
    var ub = $("unbill");
    if (ub) ub.onclick = function () { state.billed = null; runAnalysis(); renderHandoff(); };

    renderAging();
    renderCards();
    renderRubric();
    $("slack").textContent = slackText();
  }

  function slackText() {
    // ar.js escapes for Slack's API; the copy button wants plain text.
    return mask(AR.slackDigest(state.result).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  }

  // "overdue": oldest invoice first. "amount": largest open balance first.
  function sorted(list, by, onlyYou) {
    return list.filter(function (c) { return !onlyYou || c.needsYou; }).sort(function (a, b) {
      return by === "amount" ? (b.balance - a.balance) || (b.oldestDays - a.oldestDays)
        : (b.oldestDays - a.oldestDays) || (b.balance - a.balance);
    });
  }

  function renderAging() {
    var res = state.result;
    $("legend").innerHTML = AR.BUCKETS.map(function (b) {
      return '<span><i style="background:var(' + BUCKET_VARS[b.key] + ')"></i>' + b.label + (b.key === "current" ? "" : " days") + "</span>";
    }).join("");
    var head = "<thead><tr><th>Customer</th>" + AR.BUCKETS.map(function (b) { return "<th>" + b.label + "</th>"; }).join("") + "<th>Total</th><th></th></tr></thead>";
    var rows = sorted(res.customers, state.sort.aging, state.onlyYou.aging);
    var body = rows.map(function (c) {
      var bar = AR.BUCKETS.map(function (b) {
        var v = c.buckets[b.key];
        return v ? '<span style="width:' + (v / c.balance * 100).toFixed(2) + "%;background:var(" + BUCKET_VARS[b.key] + ')" title="' + b.label + ": " + money(v) + '"></span>' : "";
      }).join("");
      var meta = [];
      if (isDemo()) meta.push('<span class="tag demo">Demo</span>');
      if (c.needsYou) meta.push('<span class="tag you">Needs action</span>');
      if (c.actioned) meta.push('<span class="tag done">Actioned</span>');
      meta.push("<span>" + (c.tier ? c.oldestDays + " days overdue · " + esc(contactText(c).replace("Last contacted", "contacted").replace("No contact logged", "no contact logged")) : "Not yet due") + "</span>");
      return "<tr><td class=\"name\"><div class=\"n\">" + esc(c.name) + '</div><div class="meta">' + meta.join("") + "</div></td>" +
        AR.BUCKETS.map(function (b) { var v = c.buckets[b.key]; return '<td class="b' + (v ? "" : " zero") + '">' + (v ? money(v) : "–") + "</td>"; }).join("") +
        '<td class="tot">' + money(c.balance) + '</td><td class="barcell"><div class="bar" role="img" aria-label="' + esc(c.name) + " aging split\">" + bar + "</div></td></tr>";
    }).join("");
    var tot = { current: 0, b1: 0, b31: 0, b61: 0, b90: 0 };
    var shownTotal = 0;
    rows.forEach(function (c) { shownTotal += c.balance; Object.keys(tot).forEach(function (k) { tot[k] += c.buckets[k]; }); });
    var foot = "<tfoot><tr><td>" + (state.onlyYou.aging ? "Total, needs action" : "Total") + "</td>" + AR.BUCKETS.map(function (b) { return '<td class="b">' + money(tot[b.key]) + "</td>"; }).join("") +
      '<td class="tot">' + money(shownTotal) + "</td><td></td></tr></tfoot>";
    $("aging").innerHTML = head + "<tbody>" + body + "</tbody>" + foot;

    var ex = res.excluded, parts = [];
    if (ex.paid) parts.push(ex.paid + " paid or void");
    if (ex.nonPositive) parts.push(ex.nonPositive + " zero or negative balance (incl. credit notes)");
    if (ex.noDueDate) parts.push(ex.noDueDate + " missing a due date");
    if (ex.duplicate) parts.push(ex.duplicate + " duplicate invoice #");
    if (ex.unreadable) parts.push(ex.unreadable + " unreadable");
    var nRows = allRows().length;
    $("excluded").textContent = res.excludedTotal
      ? "Excluded " + res.excludedTotal + " of " + nRows + " rows: " + parts.join(", ") + "."
      : "No rows excluded (" + nRows + " rows).";
  }

  function tierBadge(c) {
    var label = c.action === "billing" ? "Billing question" : AR.TIER_NAMES[c.tier];
    var col = TIER_COLORS[c.tier];
    return '<span class="tier" style="color:' + col + ";border-color:" + col + '55"><i style="background:' + col + '"></i>Tier ' + c.tier + " · " + esc(label) + "</span>";
  }

  function renderCards() {
    var res = state.result;
    var shown = sorted(res.customers.filter(function (c) { return c.tier >= 1; }), state.sort.drafts, state.onlyYou.drafts);
    $("cards").innerHTML = shown.map(function (c) {
      var d = state.drafts[c.id];
      var facts = money(c.balance) + " open · " + c.invoices.length + " invoice" + (c.invoices.length === 1 ? "" : "s") + " · " + c.oldestDays + " days overdue";
      var flags = c.flags.map(function (f) { return "<li>" + esc(mask(f)) + "</li>"; });
      if (c.toneNote && c.action === "chase") flags.push('<li class="tone">' + esc(c.toneNote) + "</li>");
      if (d.rejected) flags.push("<li>AI draft failed a rule check (" + esc(mask(d.rejected[0])) + "), template used</li>");
      var why = c.tier === 5 ? "Over 90 days. This needs a call from you, not another email."
        : !c.email ? "No contact email in the export. Fix the record and re-run."
        : "Check this account before anything goes out.";
      var preview = d.body ? "Draft ready: " + d.subject : why;
      var summary = '<summary><div class="sl"><div class="cname">' + esc(c.name) + "</div>" +
        '<div class="facts num">' + (isDemo() ? '<span class="tag demo">Demo</span> ' : "") + facts + "</div>" +
        '<div class="contact">' + esc(contactText(c)) + "</div>" +
        '<div class="preview">' + esc(preview) + "</div></div>" +
        '<div class="sr2">' + (c.needsYou ? '<span class="tag you">Needs action</span>' : "") + tierBadge(c) +
        '<span class="act' + (c.actioned ? " on" : "") + '" data-act="' + c.id + '" role="checkbox" tabindex="0" aria-checked="' + c.actioned + '" title="Tick once handled. Clears Needs action and logs today as last contacted.">' +
        '<input type="checkbox" tabindex="-1" aria-hidden="true"' + (c.actioned ? " checked" : "") + '>Actioned</span>' +
        '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div></summary>';
      var fl = flags.length ? '<ul class="flags">' + flags.join("") + "</ul>" : "";
      var bd;
      if (!d.body) {
        bd = '<div class="bd">' + fl + '<div class="needs"><b>Needs action</b><p>' + esc(why) + "</p></div></div>";
      } else {
        bd = '<div class="bd">' + fl + '<div class="addr"><b>To</b> ' + esc(d.to) + (d.cc ? " · <b>Cc</b> " + esc(d.cc) : "") +
          (c.tier === 4 ? " · <b>Send from founder</b>" : "") + "</div>" +
          '<input class="subj" data-id="' + c.id + '" aria-label="Subject" value="' + esc(d.subject) + '">' +
          '<textarea data-id="' + c.id + '" aria-label="Email body" spellcheck="true">' + esc(d.body) + "</textarea>" +
          '<div class="ft"><button class="btn primary" type="button" data-copy="' + c.id + '">Copy</button>' +
          '<a class="btn" target="_blank" rel="noopener" data-gmail="' + c.id + '" href="' + gmailUrl(d) + '">Open in Gmail</a>' +
          '<span class="src">' + (d.source === "claude" ? "Drafted by AI" : "Template") + (state.dirty[c.id] ? " · edited" : "") + "</span></div></div>";
      }
      return '<details class="card' + (c.needsYou ? " you" : "") + (c.actioned ? " done" : "") + '" data-card="' + c.id + '"' + (state.open[c.id] ? " open" : "") + ">" + summary + bd + "</details>";
    }).join("");

    document.querySelectorAll("#cards textarea").forEach(fit);

    var listed = res.customers.filter(function (c) { return c.tier === 0; });
    $("listed").innerHTML = listed.length && !state.onlyYou.drafts
      ? "<b>Not yet due, no action:</b> " + listed.map(function (c) { return esc(c.name) + " (" + money(c.balance) + ")"; }).join(", ")
      : "";
  }

  function fit(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }

  function gmailUrl(d) {
    var q = "view=cm&fs=1&to=" + encodeURIComponent(d.to || "") + (d.cc ? "&cc=" + encodeURIComponent(d.cc) : "") +
      "&su=" + encodeURIComponent(d.subject) + "&body=" + encodeURIComponent(d.body);
    return "https://mail.google.com/mail/?" + q;
  }

  function renderRubric() {
    if ($("rubric").dataset.done) return;
    $("rubric").dataset.done = "1";
    $("rubric").innerHTML = "<table><thead><tr><th>Tier</th><th>Days overdue</th><th>Tone</th><th>Must include</th><th>Ask</th></tr></thead><tbody>" +
      AR.RUBRIC.map(function (r) {
        return "<tr><td><b>" + r.tier + "</b></td><td>" + esc(r.days) + "</td><td>" + esc(r.tone) + "</td><td>" + esc(r.include) + "</td><td>" + esc(r.ask) + "</td></tr>";
      }).join("") + "</tbody></table>" +
      "<ul><li><b>Disputed:</b> no chaser; a billing-question reply instead.</li>" +
      "<li><b>Partial payment:</b> thanks them for what arrived and chases only the remainder.</li>" +
      "<li><b>No late payments in 12 months:</b> tone one step softer. <b>Two or more:</b> one step firmer. Tier stays for routing.</li>" +
      "<li><b>Over 20% of total AR:</b> flagged “Needs action”, still drafted.</li>" +
      "<li><b>Missing contact email:</b> no draft, flagged for data cleanup.</li>" +
      "<li><b>Hard rules:</b> figures only from the export, no legal or collections language, no fees unless the terms state one, under 120 words, no exclamation marks.</li></ul>";
  }

  // ---------- Copy helpers ----------

  function copy(text, btn) {
    var done = function () {
      var t = btn.textContent; btn.textContent = "Copied"; btn.classList.add("done");
      setTimeout(function () { btn.textContent = t; btn.classList.remove("done"); }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* leave text selectable */ }
      ta.remove();
    }
  }

  // ---------- Apps Script ----------

  var scriptText = "";
  function loadScript() {
    Promise.all([fetch("ar.js").then(function (r) { return r.text(); }), fetch("sheet-runner.js").then(function (r) { return r.text(); })])
      .then(function (parts) {
        scriptText = "/* SnapMagic AR chaser: Google Apps Script. Generated from the same core as the web page. */\n\n" + parts[0] + "\n\n" + parts[1];
        $("scriptCode").textContent = scriptText;
        $("scriptSize").textContent = "· " + scriptText.split("\n").length + " lines";
      })
      .catch(function () { $("scriptCode").textContent = "Couldn't load the script. Serve the page over http(s) rather than file://."; });
  }

  // ---------- Stages ----------

  function setStage(s, quiet) {
    state.stage = s;
    document.body.dataset.stage = s;
    $("stageBill").setAttribute("aria-selected", s === "bill");
    $("stageAge").setAttribute("aria-selected", s === "age");
    try { history.replaceState(null, "", s === "age" ? "#aging" : "#billing"); } catch (e) { /* file:// */ }
    if (!quiet) window.scrollTo({ top: 0 });
    if (s === "age") document.querySelectorAll("#cards textarea").forEach(fit);
    else document.querySelectorAll("#invCards textarea").forEach(fit);
  }

  // ---------- Month-end billing ----------

  function billDemo() { return state.bill.source === "demo"; }
  function bMask(text) { return billDemo() ? String(text).replace(MONEY_RE, "$$xx") : String(text); }
  function bMoney(n) { return billDemo() ? "$xx" : AR.fmtMoney(n); }
  function bK(n) { return billDemo() ? "$xx" : AR.fmtK(n); }
  function signed(n) { return billDemo() ? (n < 0 ? "−$xx" : "+$xx") : (n < 0 ? "−" : "+") + AR.fmtK(Math.abs(n)); }

  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type || "text/csv" }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function loadBillDemo() {
    var p = AR.parseCSV(DEMO.contractsCSV(state.bill.period));
    var b = state.bill;
    b.source = "demo"; b.fileName = ""; b.headers = p.headers; b.rows = p.rows; b.map = BILL.autoMap(p.headers);
    $("billMapper").innerHTML = "";
    runBilling();
  }

  function runBilling() {
    var b = state.bill;
    b.run = BILL.billingRun(b.rows, b.map, b.period);
    b.emails = {}; b.dirty = {};
    b.run.invoices.forEach(function (inv, i) {
      inv.id = i;
      var e = BILL.coverEmail(inv, b.run, state.settings);
      if (billDemo()) { e.subject = bMask(e.subject); e.body = bMask(e.body); }
      b.emails[i] = e;
    });
    renderBilling();
  }

  function kindBadge(inv) {
    var n = inv.notes.join(" "), c = inv.contracts;
    if (/New contract/.test(n)) return '<span class="badge new">New</span>';
    if (/final invoice/.test(n)) return '<span class="badge final">Final</span>';
    if (c.some(function (x) { return x.freq.months === 12 && x.onCycle; })) return '<span class="badge">Annual</span>';
    if (c.some(function (x) { return x.freq.months === 3 && x.onCycle; })) return '<span class="badge">Quarterly</span>';
    if (c.some(function (x) { return x.usage; })) return '<span class="badge">Usage</span>';
    if (/renewal/.test(n)) return '<span class="badge final">Renewal due</span>';
    return '<span class="badge">Monthly</span>';
  }

  function renderBilling() {
    var b = state.bill, run = b.run, P = run.period;
    $("billMonth").value = P.key;
    var n = run.invoices.length;
    $("billHeadline").innerHTML = n + " invoice" + (n === 1 ? "" : "s") + " to send" +
      '<span class="sep">·</span><small>' + bK(run.total) + " billed</small>";
    $("billDates").innerHTML = "Billing month <b>" + esc(P.label) + "</b><br>Issued <b>" + esc(AR.fmtDate(P.end)) + "</b>";

    var needs = run.invoices.filter(function (i) { return i.needsYou; }).map(function (i) { return i.customer; })
      .concat(run.skipped.filter(function (s) { return s.needsYou; }).map(function (s) { return s.customer; }));
    var co = [];
    if (needs.length) co.push('<span class="callout you"><b>' + needs.length + " to check before sending</b>: " + needs.map(esc).join(", ") + "</span>");
    if (run.bridge) co.push('<span class="callout"><b>' + signed(run.bridge.change) + "</b> on last month, " + run.bridge.items.length + " change" + (run.bridge.items.length === 1 ? "" : "s") + " explained</span>");
    var off = run.skipped.filter(function (s) { return !s.needsYou; }).length;
    if (off) co.push('<span class="callout"><b>' + off + "</b> contract" + (off === 1 ? "" : "s") + " not billed this month</span>");
    if (run.unreadable) co.push('<span class="callout"><b>' + run.unreadable + "</b> unreadable row" + (run.unreadable === 1 ? "" : "s") + " (no customer or fee)</span>");
    $("billCallouts").innerHTML = co.join("");

    $("billSrc").innerHTML = billDemo()
      ? '<span class="pill demo">Demo contracts</span><span>' + b.rows.length + " fictional contracts across " + new Set(b.rows.map(function (r) { return r[b.map.customer]; })).size + " customers</span>" +
        '<span class="spacer"></span><label for="billFile" class="btn" tabindex="0" data-bpick>Upload contracts CSV</label><button class="btn ghost" type="button" id="billTpl">Template</button>'
      : '<span class="pill file">' + esc(b.fileName) + "</span><span>" + b.rows.length + " contracts</span>" +
        '<span class="spacer"></span><label for="billFile" class="btn" tabindex="0" data-bpick>Choose another file</label><button class="btn ghost" type="button" id="billBackDemo">Back to demo</button>';
    if ($("billTpl")) $("billTpl").onclick = function () { download("billing-contracts-template.csv", billTemplate()); };
    if ($("billBackDemo")) $("billBackDemo").onclick = loadBillDemo;

    renderBridge();
    renderInvoices();
    var nb = run.skipped;
    $("notBilled").innerHTML = nb.length
      ? "<b>Not billed this month:</b> " + nb.map(function (s) { return esc(s.customer) + " (" + esc(s.reason) + ")"; }).join("; ")
      : "";
    renderBillRules();
    renderHandoff();
  }

  function renderBridge() {
    var br = state.bill.run.bridge;
    if (!br) {
      $("bridge").innerHTML = '<p class="sub">Add a “Last month billed” column to the contracts file to see what changed since last month.</p>';
      return;
    }
    var cum = br.last, scale = Math.max(br.last, br.now);
    br.items.forEach(function (it) { cum += it.delta; scale = Math.max(scale, cum); });
    scale = scale || 1;
    var pct = function (v) { return (Math.max(0, v) / scale * 100).toFixed(2) + "%"; };
    var row = function (who, sub, amtCls, amt, barCls, left, width) {
      return '<div class="brow' + (amtCls === "tot" && who === "This month" ? " total" : "") + '"><div class="who"><b>' + who + "</b>" + (sub ? "<span>" + sub + "</span>" : "") + '</div><div class="amt ' + amtCls + '">' + amt + "</div>" +
        '<div class="bar3"><div class="track"><i class="' + barCls + '" style="left:' + left + ";width:" + width + '"></i></div></div></div>';
    };
    var html = row("Last month", "Billed on these contracts", "tot", bK(br.last), "base", "0%", pct(br.last));
    cum = br.last;
    br.items.forEach(function (it) {
      var from = Math.min(cum, cum + it.delta);
      html += row(esc(it.customer), esc(it.contract) + " · " + esc(it.reason), it.delta > 0 ? "up" : "down", signed(it.delta), it.delta > 0 ? "up" : "down", Math.min(from / scale * 100, 99.3).toFixed(2) + "%", pct(Math.abs(it.delta)));
      cum += it.delta;
    });
    html += row("This month", state.bill.run.invoices.length + " invoices", "tot", bK(br.now), "base", "0%", pct(br.now));
    $("bridge").innerHTML = html;
  }

  function renderInvoices() {
    var b = state.bill, run = b.run;
    var list = run.invoices.slice().sort(function (x, y) { return (y.needsYou - x.needsYou) || x.customer.localeCompare(y.customer); });
    $("invCards").innerHTML = list.map(function (inv) {
      var e = b.emails[inv.id];
      var facts = esc(inv.number) + " · " + bMoney(inv.total) + " · " + inv.lines.length + " line" + (inv.lines.length === 1 ? "" : "s") + " · due " + esc(AR.fmtShortDate(inv.dueDate));
      var summary = '<summary><div class="sl"><div class="cname">' + esc(inv.customer) + "</div>" +
        '<div class="facts num">' + (billDemo() ? '<span class="tag demo">Demo</span> ' : "") + facts + "</div>" +
        '<div class="contact">' + (inv.email ? esc(inv.email) : "No billing email") + "</div>" +
        '<div class="preview">' + esc(inv.flags[0] || inv.notes[0] || "Ready to send") + "</div></div>" +
        '<div class="sr2">' + (inv.needsYou ? '<span class="tag you">Needs action</span>' : "") + kindBadge(inv) +
        '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div></summary>';
      var flags = inv.flags.length ? '<ul class="flags">' + inv.flags.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>" : "";
      var notes = inv.notes.length ? '<ul class="notes">' + inv.notes.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>" : "";
      var lines = '<table class="lines num"><thead><tr><th>Line</th><th class="r hide-sm">Qty</th><th class="r hide-sm">Rate</th><th class="r">Amount</th></tr></thead><tbody>' +
        inv.lines.map(function (l) {
          return "<tr><td>" + esc(l.description) + '</td><td class="r hide-sm">' + l.qty.toLocaleString("en-US") + '</td><td class="r hide-sm">' + bMoney(l.rate) + '</td><td class="r">' + bMoney(l.amount) + "</td></tr>";
        }).join("") + '</tbody><tfoot><tr><td>Total' + (inv.pos.length ? " · PO " + esc(inv.pos.join(", ")) : "") + '</td><td class="hide-sm"></td><td class="hide-sm"></td><td class="r">' + bMoney(inv.total) + "</td></tr></tfoot></table>";
      var view = '<button class="btn" type="button" data-view="' + inv.id + '">Download PDF</button>';
      var mail = inv.email
        ? '<div class="addr"><b>To</b> ' + esc(e.to) + (e.cc ? " · <b>Cc</b> " + esc(e.cc) : "") + "</div>" +
          '<input class="subj" data-bid="' + inv.id + '" aria-label="Subject" value="' + esc(e.subject) + '">' +
          '<textarea data-bid="' + inv.id + '" aria-label="Cover email" spellcheck="true">' + esc(e.body) + "</textarea>" +
          '<div class="ft"><button class="btn primary" type="button" data-bcopy="' + inv.id + '">Copy email</button>' +
          '<a class="btn" target="_blank" rel="noopener" data-bgmail="' + inv.id + '" href="' + gmailUrl(e) + '">Open in Gmail</a>' + view +
          '<span class="src">Template' + (b.dirty[inv.id] ? " · edited" : "") + "</span></div>"
        : '<div class="needs"><b>Needs action</b><p>No billing email on the contract. Add one and re-run before this invoice can go out.</p></div><div class="ft">' + view + "</div>";
      return '<details class="card' + (inv.needsYou ? " you" : "") + '" data-inv="' + inv.id + '"' + (b.open[inv.id] ? " open" : "") + ">" + summary +
        '<div class="bd">' + flags + notes + lines + mail + "</div></details>";
    }).join("");
    document.querySelectorAll("#invCards textarea").forEach(fit);
  }

  function renderBillRules() {
    if ($("billRules").dataset.done) return;
    $("billRules").dataset.done = "1";
    $("billRules").innerHTML = "<ul>" +
      "<li><b>Who's billed:</b> contracts active in the month and on their cycle, billed in advance. Monthly bills every month, quarterly every third month from the start month, annual in the start month each year.</li>" +
      "<li><b>Proration:</b> a monthly contract that starts or ends mid-month is billed for the days it covers.</li>" +
      "<li><b>Usage:</b> usage units × unit price, as its own line.</li>" +
      "<li><b>One invoice per customer:</b> a line for each contract, numbered INV-YYMM-001 onwards, issued on the last day of the month and due on the customer's terms (Net 30 if blank).</li>" +
      "<li><b>Checked before sending:</b> no billing email, a PO required but missing, a monthly bill up or down 25% or more on last month with no new, final or cycle reason, duplicate contracts, and rows with no start date or an unknown frequency.</li>" +
      "<li><b>Heads-up:</b> contracts ending within 60 days get a renewal note.</li>" +
      "<li><b>Bridge:</b> last month's total to this month's, with a reason for every change: new, ended, price change, usage, or a quarterly or annual bill.</li>" +
      "<li><b>Hand-off:</b> the invoices join the aging run as open invoices, so the fortnightly chasers pick them up once they fall due. The QuickBooks file is laid out for QuickBooks Online's invoice import.</li>" +
      "</ul>";
  }

  function renderHandoff() {
    var run = state.bill.run;
    if (!run) return;
    var ready = run.invoices.filter(function (i) { return !i.needsYou; }).length;
    $("handoff").innerHTML = "<p><b>" + run.invoices.length + " invoices · " + bK(run.total) + "</b>, issued " + esc(AR.fmtShortDate(run.period.end)) + ". " +
      ready + " ready, " + (run.invoices.length - ready) + " to check first.</p>" +
      '<button class="btn" type="button" id="dlPdfs">All invoices PDF</button>' +
      '<button class="btn" type="button" id="dlQbo">QuickBooks import CSV</button>' +
      '<button class="btn" type="button" id="dlAr">AR rows CSV</button>' +
      '<button class="btn primary" type="button" id="toAging">Send to aging run</button>';
    $("dlPdfs").onclick = function (e) { downloadPDF(run.invoices, "invoices-" + run.period.key + ".pdf", e.target); };
    $("dlQbo").onclick = function () { download("invoices-" + run.period.key + "-quickbooks.csv", BILL.importCSV(run)); };
    $("dlAr").onclick = function () { download("invoices-" + run.period.key + "-ar-rows.csv", BILL.arCSV(run)); };
    $("toAging").onclick = sendToAging;
    var b = state.billed;
    $("sentNote").hidden = !(b && b.key === run.period.key);
    if (b) $("sentNote").textContent = "Sent: " + b.count + " invoices are in the aging run. Move its run date past " + AR.fmtDate(b.firstDue) + " to watch them come due.";
  }

  function sendToAging() {
    var run = state.bill.run;
    if (!run || !run.invoices.length) return;
    state.billed = {
      key: run.period.key, label: run.period.label, count: run.invoices.length, demo: billDemo(),
      firstDue: Math.min.apply(null, run.invoices.map(function (i) { return i.dueDate; })),
      records: BILL.arRecords(run)
    };
    if (state.tab === "upload" && isDemo()) setTab("demo");
    runAnalysis();
    renderHandoff();
    setStage("age");
  }

  function billTemplate() {
    return DEMO.CONTRACT_HEADERS.join(",") + "\n" +
      "C-001,Customer A,billing@customer-a.example,,Sponsored placement,2400.00,Monthly,2026-01-01,2026-12-31,PO-1001,Yes,,,Net 30,2400.00\n" +
      "C-002,Customer B,billing@customer-b.example,payables@customer-b.example,CAD model library build,9000.00,Quarterly,2026-04-01,,,,,,Net 45,\n" +
      "C-003,Customer C,billing@customer-c.example,,Sponsored placement,5000.00,Monthly,2026-03-01,,,,1240,1.50,Net 30,6420.00\n";
  }

  function renderBillGuide() {
    var need = function (f) {
      return f.required ? '<span class="need req">Required</span>' : f.recommended ? '<span class="need rec">Recommended</span>' : '<span class="need opt">Optional</span>';
    };
    var names = {};
    DEMO.CONTRACT_HEADERS.forEach(function (h) { var k = BILL.autoMap([h]); Object.keys(k).forEach(function (x) { names[x] = h; }); });
    $("billGuideTable").innerHTML = "<table><thead><tr><th>Column</th><th></th><th>What it's used for</th></tr></thead><tbody>" +
      BILL.FIELDS.map(function (f) {
        return '<tr><td class="f">' + esc(names[f.key] || f.label) + "</td><td>" + need(f) + '</td><td class="u">' + esc(f.use) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function loadBillFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var p = AR.parseCSV(reader.result);
      if (!p.headers.length || !p.rows.length) { $("billMapper").innerHTML = '<div class="mapper"><p class="err">That file has no rows.</p></div>'; return; }
      state.bill.pending = { headers: p.headers, rows: p.rows, name: file.name };
      renderBillMapper(p.headers, BILL.autoMap(p.headers), file.name, p.rows.length);
    };
    reader.readAsText(file);
  }

  function renderBillMapper(headers, map, name, n) {
    var opts = function (sel) {
      return '<option value="">Not in file</option>' + headers.map(function (h) {
        return '<option value="' + esc(h) + '"' + (h === sel ? " selected" : "") + ">" + esc(h) + "</option>";
      }).join("");
    };
    $("billMapper").innerHTML =
      '<div class="mapper" style="margin-top:20px"><h3>Match columns: ' + esc(name) + "</h3>" +
      "<p>" + n + " rows. Matched from your headers; check anything marked required. The column guide at the bottom says what each one does.</p>" +
      '<div class="mapgrid">' + BILL.FIELDS.map(function (f) {
        return "<label>" + esc(f.label) + (f.required ? ' <span class="req">required</span>' : "") +
          '<select data-bk="' + f.key + '">' + opts(map[f.key]) + "</select></label>";
      }).join("") + "</div>" +
      '<div class="actions"><button class="btn primary" id="bApply" type="button">Run billing</button>' +
      '<button class="btn ghost" id="bCancel" type="button">Cancel</button><span class="err" id="bErr"></span></div></div>';
    $("bApply").onclick = function () {
      var m = {};
      document.querySelectorAll("#billMapper select").forEach(function (s) { if (s.value) m[s.dataset.bk] = s.value; });
      var miss = BILL.missingRequired(m);
      if (miss.length) { $("bErr").textContent = "Still needed: " + miss.join(", "); return; }
      var b = state.bill, pd = b.pending;
      b.source = "file"; b.fileName = pd.name; b.headers = pd.headers; b.rows = pd.rows; b.map = m;
      $("billMapper").innerHTML = "";
      runBilling();
    };
    $("bCancel").onclick = function () { $("billMapper").innerHTML = ""; };
    $("billMapper").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* Invoice PDFs are drawn in the browser and saved directly. jsPDF is vendored and loaded on first use. */
  var pdfLib = null;
  function withPDF(fn) {
    if (window.jspdf) return fn(window.jspdf.jsPDF);
    if (!pdfLib) pdfLib = new Promise(function (ok, fail) {
      var s = document.createElement("script");
      s.src = "vendor/jspdf-2.5.1.umd.min.js";
      s.onload = function () { ok(window.jspdf.jsPDF); };
      s.onerror = function () { pdfLib = null; fail(new Error("load")); };
      document.head.appendChild(s);
    });
    pdfLib.then(fn, function () { alert("Couldn't load the PDF generator. Check your connection and try again."); });
  }
  function downloadPDF(invoices, name, btn) {
    var label = btn && btn.textContent;
    if (btn) { btn.textContent = "Preparing…"; btn.disabled = true; }
    withPDF(function (jsPDF) {
      INVPDF.build(jsPDF, invoices, state.bill.run, billDemo()).save(name);
      if (btn) { btn.textContent = "Downloaded"; btn.classList.add("done"); setTimeout(function () { btn.textContent = label; btn.disabled = false; btn.classList.remove("done"); }, 1400); }
    });
  }

  // ---------- Events ----------

  $("runDate").addEventListener("change", function (e) {
    var t = AR.parseDate(e.target.value);
    if (t == null) return;
    state.runDate = t;
    runAnalysis();
  });
  $("file").addEventListener("change", function (e) { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
  $("uploadPanel").addEventListener("keydown", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-pick") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); $("file").click(); }
  });
  document.querySelectorAll(".seg").forEach(function (seg) {
    seg.addEventListener("click", function (e) {
      var d = e.target.dataset || {}, list = seg.dataset.list;
      if (d.filter === "you") {
        state.onlyYou[list] = !state.onlyYou[list];
        e.target.setAttribute("aria-pressed", state.onlyYou[list]);
      } else if (d.sort) {
        state.sort[list] = d.sort;
        seg.querySelectorAll("[data-sort]").forEach(function (b) { b.setAttribute("aria-pressed", b.dataset.sort === d.sort); });
      } else return;
      if (seg.dataset.list === "aging") renderAging(); else renderCards();
    });
  });
  $("tabDemo").addEventListener("click", function () { setTab("demo"); });
  $("tabUpload").addEventListener("click", function () { setTab("upload"); });

  ["sName", "sRole", "fName", "fRole"].forEach(function (id, i) {
    $(id).value = state.settings[["senderName", "senderRole", "founderName", "founderRole"][i]];
  });
  $("saveSign").addEventListener("click", function () {
    state.settings.senderName = $("sName").value.trim() || AR.DEFAULT_SETTINGS.senderName;
    state.settings.senderRole = $("sRole").value.trim() || AR.DEFAULT_SETTINGS.senderRole;
    state.settings.founderName = $("fName").value.trim() || AR.DEFAULT_SETTINGS.founderName;
    state.settings.founderRole = $("fRole").value.trim() || AR.DEFAULT_SETTINGS.founderRole;
    $("settings").open = false;
    runAnalysis();
    if (state.bill.run) runBilling();
  });

  // Billing events
  $("stageBill").addEventListener("click", function () { setStage("bill"); });
  $("stageAge").addEventListener("click", function () { setStage("age"); });
  $("billMonth").addEventListener("change", function (e) {
    var P = BILL.periodOf(e.target.value);
    if (!P) return;
    state.bill.period = P.start;
    if (billDemo()) loadBillDemo(); else runBilling();
  });
  $("billFile").addEventListener("change", function (e) { if (e.target.files[0]) loadBillFile(e.target.files[0]); e.target.value = ""; });
  $("billStage").addEventListener("keydown", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-bpick") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); $("billFile").click(); }
  });
  $("invCards").addEventListener("toggle", function (e) {
    var el = e.target; if (!el.dataset || el.dataset.inv == null) return;
    state.bill.open[el.dataset.inv] = el.open;
    if (el.open) el.querySelectorAll("textarea").forEach(fit);
  }, true);
  $("invCards").addEventListener("input", function (e) {
    var id = e.target.dataset.bid; if (id == null) return;
    var d = state.bill.emails[id];
    if (e.target.tagName === "TEXTAREA") { d.body = e.target.value; fit(e.target); } else d.subject = e.target.value;
    state.bill.dirty[id] = true;
    var a = document.querySelector('[data-bgmail="' + id + '"]'); if (a) a.href = gmailUrl(d);
  });
  $("invCards").addEventListener("click", function (e) {
    var t = e.target;
    if (t.dataset.view != null) { var vi = state.bill.run.invoices[+t.dataset.view]; downloadPDF([vi], vi.number + ".pdf", t); return; }
    if (t.dataset.bcopy != null) { var d = state.bill.emails[t.dataset.bcopy]; copy("Subject: " + d.subject + "\n\n" + d.body, t); }
  });

  // Cards are collapsed by default; remember which are open across re-renders.
  $("cards").addEventListener("toggle", function (e) {
    var el = e.target; if (!el.dataset || el.dataset.card == null) return;
    state.open[el.dataset.card] = el.open;
    if (el.open) el.querySelectorAll("textarea").forEach(fit);
  }, true);

  $("cards").addEventListener("keydown", function (e) {
    if ((e.key === " " || e.key === "Enter") && e.target.dataset && e.target.dataset.act != null) { e.preventDefault(); e.target.click(); }
  });

  $("cards").addEventListener("input", function (e) {
    var id = e.target.dataset.id; if (id == null) return;
    var d = state.drafts[id];
    if (e.target.tagName === "TEXTAREA") { d.body = e.target.value; fit(e.target); } else d.subject = e.target.value;
    state.dirty[id] = true;
    var a = document.querySelector('[data-gmail="' + id + '"]'); if (a) a.href = gmailUrl(d);
  });
  $("cards").addEventListener("click", function (e) {
    var act = e.target.closest && e.target.closest("[data-act]");
    if (act) {
      // Handle the tick ourselves so the click doesn't also open or close the card.
      e.preventDefault();
      var c = state.result.customers[act.dataset.act];
      writeTick(c, c.actioned ? null : AR.isoDate(state.runDate));
      applyTicks(state.result);
      render();
      var again = document.querySelector('[data-act="' + c.id + '"]'); if (again) again.focus();
      return;
    }
    var id = e.target.dataset.copy; if (id == null) return;
    var d = state.drafts[id];
    copy("Subject: " + d.subject + "\n\n" + d.body, e.target);
  });
  $("copySlack").addEventListener("click", function (e) { copy(slackText(), e.target); });
  $("copyScript").addEventListener("click", function (e) { if (scriptText) copy(scriptText, e.target); });
  $("dlScript").addEventListener("click", function () {
    if (!scriptText) return;
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([scriptText], { type: "text/javascript" }));
    a.download = "Code.gs"; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  renderGuide();
  renderBillGuide();
  loadDemo();
  loadBillDemo();
  loadScript();
  setStage(/^#(aging|age|ar)/.test(location.hash) ? "age" : "bill", true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { document.querySelectorAll("#cards textarea").forEach(fit); });
})();
