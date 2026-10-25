/* AR chaser core: CSV parsing, column mapping, aging, escalation rubric,
 * template drafts and output validation. No DOM, no network.
 * Runs in the browser, in Node (tests) and inside Google Apps Script,
 * which is how the scheduled script applies exactly the same rules. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AR = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DAY = 86400000;
  var CYCLE_DAYS = 14; // the aging run repeats every two weeks

  // ---------- CSV ----------

  function parseCSV(text) {
    text = String(text || "").replace(/^﻿/, "");
    var rows = [], row = [], field = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(function (f) { return f.trim() !== ""; })) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(function (f) { return f.trim() !== ""; })) rows.push(row);
    if (!rows.length) return { headers: [], rows: [] };
    var headers = rows[0].map(function (h) { return h.trim(); });
    return {
      headers: headers,
      rows: rows.slice(1).map(function (r) {
        var o = {};
        headers.forEach(function (h, j) { o[h] = (r[j] == null ? "" : r[j]).trim(); });
        return o;
      })
    };
  }

  // ---------- Column mapping ----------

  // Synonyms cover HubSpot invoice exports and QuickBooks A/R detail / invoice list exports.
  var FIELDS = [
    { key: "invoice", label: "Invoice #", required: true, use: "Listed in each email. Duplicates are counted once and flagged.", syn: ["invoice number", "invoice #", "invoice no", "invoice id", "num", "number", "invoice", "no."] },
    { key: "customer", label: "Customer", required: true, use: "Groups invoices into one email per customer.", syn: ["customer", "company name", "company", "customer name", "associated company", "client", "name", "account"] },
    { key: "email", label: "Contact email", use: "Where the draft goes. Without it the customer is flagged and gets no draft.", recommended: true, syn: ["contact email", "billing email", "email", "customer email", "bill to email", "e-mail"] },
    { key: "ccEmail", label: "AP / finance email (cc)", use: "Copied on tier 3 (31 to 60 days) emails.", syn: ["ap email", "accounts payable email", "finance email", "cc email", "cc"] },
    { key: "amount", label: "Amount", required: true, use: "Invoice total. Zero or negative rows (credit notes) are excluded.", syn: ["amount", "invoice amount", "total", "amount billed", "invoice total", "original amount"] },
    { key: "paid", label: "Amount paid", use: "Nets partial payments so only the remainder is chased.", recommended: true, syn: ["amount paid", "paid", "payments", "amount received", "paid amount"] },
    { key: "balance", label: "Open balance", use: "Alternative to Amount paid, as in QuickBooks exports.", syn: ["open balance", "balance due", "balance", "amount due", "outstanding"] },
    { key: "issueDate", label: "Issue date", use: "Reference only.", syn: ["issue date", "invoice date", "date", "created date", "txn date"] },
    { key: "dueDate", label: "Due date", required: true, use: "Sets days overdue, bucket and tier. Rows without one are excluded.", syn: ["due date", "due", "payment due date", "due on"] },
    { key: "status", label: "Status", use: "Paid or void rows are excluded. Disputed gets a billing reply instead of a chaser.", recommended: true, syn: ["status", "invoice status", "payment status", "state"] },
    { key: "terms", label: "Terms", use: "A fee can be mentioned only if the terms state one.", syn: ["terms", "payment terms", "net terms"] },
    { key: "paidDate", label: "Paid date (for late history)", use: "Late-payment history on settled invoices, which softens or firms the tone.", syn: ["paid date", "date paid", "payment date", "paid on", "last payment date"] },
    { key: "lastContacted", label: "Last contacted", use: "Shown on each overdue customer, so you can see when they were last chased.", syn: ["last contacted", "last contact", "last contact date", "last reminder", "last reminder sent", "last chased"] }
  ];

  function norm(s) { return String(s || "").toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim(); }

  function autoMap(headers) {
    var map = {}, used = {};
    FIELDS.forEach(function (f) {
      for (var i = 0; i < f.syn.length; i++) {
        var hit = headers.filter(function (h) { return !used[h] && norm(h) === f.syn[i]; })[0];
        if (hit) { map[f.key] = hit; used[hit] = true; return; }
      }
    });
    return map;
  }

  function missingRequired(map) {
    return FIELDS.filter(function (f) { return f.required && !map[f.key]; }).map(function (f) { return f.label; });
  }

  // ---------- Values ----------

  function parseMoney(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    var neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$\s]/g, ""));
    s = s.replace(/[^0-9.]/g, "");
    if (!s) return null;
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return Math.round((neg ? -n : n) * 100) / 100;
  }

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // UTC midnight for a real calendar date, or null. 2026-02-30 and month 13 are rejected
  // rather than rolled into the next month.
  function ymd(y, mo, d) {
    var t = Date.UTC(y, mo, d), dt = new Date(t);
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? t : null;
  }

  var SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

  // Returns a UTC-midnight timestamp, or null. Slash dates are read as US (MM/DD/YYYY),
  // which is what US HubSpot and QuickBooks exports produce, unless order is "dmy".
  function parseDate(v, order) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v) ? null : Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
    var s = String(v).trim(), m;
    if (!s) return null;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(SLASH))) {
      var y = +m[3]; if (y < 100) y += 2000;
      return order === "dmy" ? ymd(y, +m[2] - 1, +m[1]) : ymd(y, +m[1] - 1, +m[2]);
    }
    if ((m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})$/))) {
      var mo = MONTHS[m[2].toLowerCase()]; if (mo == null) return null;
      return ymd(+m[3], mo, +m[1]);
    }
    if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
      var mo2 = MONTHS[m[1].toLowerCase()]; if (mo2 == null) return null;
      return ymd(+m[3], mo2, +m[2]);
    }
    return null;
  }

  /* Works out whether slash dates in these columns are month first (US) or day first.
   * A first number over 12 means day first; a second number over 12 means month first.
   * With no such date the file is ambiguous and US order is assumed, so the page can say so.
   * An explicit "mdy" or "dmy" wins. */
  function dateOrderOf(rows, cols, forced) {
    var dmy = 0, mdy = 0, slash = 0;
    rows.forEach(function (r) {
      cols.forEach(function (col) {
        var m = col && String(r[col] == null ? "" : r[col]).trim().match(SLASH);
        if (!m) return;
        slash++;
        if (+m[1] > 12) dmy++;
        if (+m[2] > 12) mdy++;
      });
    });
    var detected = dmy && !mdy ? "dmy" : "mdy";
    if (forced === "mdy" || forced === "dmy") return { order: forced, ambiguous: false, mixed: false, forced: true, detected: detected };
    return { order: detected, ambiguous: slash > 0 && !dmy && !mdy, mixed: dmy > 0 && mdy > 0, forced: false, detected: detected };
  }

  function isoDate(t) { return new Date(t).toISOString().slice(0, 10); }

  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function fmtDate(t) { var d = new Date(t); return MONTH_NAMES[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear(); }
  function fmtShortDate(t) { var d = new Date(t); return MONTH_NAMES[d.getUTCMonth()].slice(0, 3) + " " + d.getUTCDate(); }
  function fmtDay(t) { var d = new Date(t); return DAY_NAMES[d.getUTCDay()] + ", " + MONTH_NAMES[d.getUTCMonth()] + " " + d.getUTCDate(); }

  function fmtMoney(n) {
    var cents = Math.round(Math.abs(n) * 100) % 100 !== 0;
    var s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return (n < 0 ? "-$" : "$") + s;
  }
  function fmtK(n) {
    if (Math.abs(n) < 1000) return fmtMoney(Math.round(n));
    return (n < 0 ? "-$" : "$") + (Math.abs(n) / 1000).toFixed(1) + "k";
  }

  function addBusinessDays(t, n) {
    var d = t;
    while (n > 0) { d += DAY; var wd = new Date(d).getUTCDay(); if (wd !== 0 && wd !== 6) n--; }
    return d;
  }

  // ---------- Rubric ----------

  var BUCKETS = [
    { key: "current", label: "Current" },
    { key: "b1", label: "1–30" },
    { key: "b31", label: "31–60" },
    { key: "b61", label: "61–90" },
    { key: "b90", label: "90+" }
  ];

  function bucketOf(days) {
    if (days <= 0) return "current";
    if (days <= 30) return "b1";
    if (days <= 60) return "b31";
    if (days <= 90) return "b61";
    return "b90";
  }

  function tierOf(days) {
    if (days <= 0) return 0;
    if (days <= 14) return 1;
    if (days <= 30) return 2;
    if (days <= 60) return 3;
    if (days <= 90) return 4;
    return 5;
  }

  var TIER_NAMES = ["Not yet due", "Friendly", "Direct", "Firm", "Final notice", "Over 90 days"];

  var RUBRIC = [
    { tier: 0, days: "Not yet due", tone: "None. Listed only", include: "–", ask: "–" },
    { tier: 1, days: "1–14", tone: "Friendly, assumes oversight", include: "Invoice #, amount, due date", ask: "Confirm a payment date" },
    { tier: 2, days: "15–30", tone: "Clear, polite, direct", include: "Amount, days overdue, invoice copy offered", ask: "A payment date by a named day (+3 business days)" },
    { tier: 3, days: "31–60", tone: "Firm, CC AP contact if known", include: "Total balance and invoice list", ask: "Payment or a date within 5 business days, offer to resolve billing issues" },
    { tier: 4, days: "61–90", tone: "Final notice, founder level", include: "Full balance and late history", ask: "A 15-minute call this week to agree a plan" },
    { tier: 5, days: "90+", tone: "No draft", include: "–", ask: "Flag “Needs action”, call suggested" }
  ];

  var DEFAULT_SETTINGS = {
    senderName: "Your name",
    senderRole: "Your role, SnapMagic",
    founderName: "Founder name",
    founderRole: "Founder, SnapMagic",
    arShareFlag: 0.2
  };

  // ---------- Aging ----------

  function isPaidStatus(s) { return /^(paid|void|voided|deleted|draft|cancel)/i.test(String(s || "").trim()); }
  function isDisputed(s) { return /disput/i.test(String(s || "")); }

  /* Build the full run: excluded counts, per-customer aging, tiers, modifiers, flags. */
  function analyze(rows, map, runDate, settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var run = typeof runDate === "number" ? runDate : parseDate(runDate);
    var g = function (r, k) { return map[k] ? r[map[k]] : ""; };
    var dates = dateOrderOf(rows, [map.dueDate, map.issueDate, map.paidDate, map.lastContacted], settings.dateOrder);
    var pd = function (v) { return parseDate(v, dates.order); };
    var excluded = { paid: 0, nonPositive: 0, noDueDate: 0, duplicate: 0, unreadable: 0, conflicts: [] };
    var seen = {}, customers = {}, history = {};

    function cust(name) {
      var key = name.toLowerCase();
      if (!customers[key]) customers[key] = { name: name, email: "", ccEmail: "", terms: "", invoices: [], flags: [], dupes: [], lastContacted: null };
      return customers[key];
    }

    rows.forEach(function (r) {
      var inv = String(g(r, "invoice") || "").trim();
      var name = String(g(r, "customer") || "").trim();
      var amount = parseMoney(g(r, "amount"));
      var paid = parseMoney(g(r, "paid")) || 0;
      var bal = map.balance ? parseMoney(g(r, "balance")) : null;
      var balance = bal != null ? bal : (amount != null ? Math.round((amount - paid) * 100) / 100 : null);
      if (bal != null && amount != null && !map.paid) paid = Math.round((amount - bal) * 100) / 100;
      var status = g(r, "status");
      var due = pd(g(r, "dueDate"));
      var paidDate = pd(g(r, "paidDate"));

      if (!inv || !name || amount == null) { excluded.unreadable++; return; }

      var dupKey = inv.toLowerCase();
      if (seen[dupKey]) {
        excluded.duplicate++;
        cust(seen[dupKey].name).dupes.push(inv);
        // Paid in one row and open in another: the first row stands, but someone should look.
        if (seen[dupKey].paid !== isPaidStatus(status)) excluded.conflicts.push(inv);
        return;
      }
      seen[dupKey] = { name: name, paid: isPaidStatus(status) };

      // Late history comes from settled invoices in the last 12 months.
      if (map.paidDate && paidDate != null && due != null && run - paidDate <= 365 * DAY && paidDate <= run) {
        var h = history[name.toLowerCase()] || (history[name.toLowerCase()] = { settled: 0, late: 0 });
        h.settled++; if (paidDate > due) h.late++;
      }

      if (isPaidStatus(status)) { excluded.paid++; return; }
      if (balance <= 0) { excluded.nonPositive++; return; }
      if (due == null) { excluded.noDueDate++; return; }

      var c = cust(name);
      if (!c.email && g(r, "email")) c.email = String(g(r, "email")).trim();
      if (!c.ccEmail && g(r, "ccEmail")) c.ccEmail = String(g(r, "ccEmail")).trim();
      if (!c.terms && g(r, "terms")) c.terms = String(g(r, "terms")).trim();
      var lc = pd(g(r, "lastContacted"));
      if (lc != null && lc <= run && (c.lastContacted == null || lc > c.lastContacted)) c.lastContacted = lc;
      var days = Math.round((run - due) / DAY);
      c.invoices.push({
        invoice: inv, amount: amount, paid: paid > 0 ? paid : 0, balance: balance,
        issueDate: pd(g(r, "issueDate")), dueDate: due, daysOverdue: days,
        bucket: bucketOf(days), disputed: isDisputed(status), status: status
      });
    });

    var list = Object.keys(customers).map(function (k) { return customers[k]; }).filter(function (c) { return c.invoices.length; });
    var totalAR = list.reduce(function (s, c) { return s + c.invoices.reduce(function (a, i) { return a + i.balance; }, 0); }, 0);
    totalAR = Math.round(totalAR * 100) / 100;

    list.forEach(function (c) {
      c.invoices.sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });
      c.buckets = { current: 0, b1: 0, b31: 0, b61: 0, b90: 0 };
      c.invoices.forEach(function (i) { c.buckets[i.bucket] = Math.round((c.buckets[i.bucket] + i.balance) * 100) / 100; });
      c.balance = Math.round(c.invoices.reduce(function (a, i) { return a + i.balance; }, 0) * 100) / 100;
      c.overdueBalance = Math.round(c.invoices.filter(function (i) { return i.daysOverdue > 0; }).reduce(function (a, i) { return a + i.balance; }, 0) * 100) / 100;
      c.over30 = Math.round((c.buckets.b31 + c.buckets.b61 + c.buckets.b90) * 100) / 100;
      c.oldestDays = c.invoices[0].daysOverdue;
      c.tier = tierOf(c.oldestDays);
      c.share = totalAR ? c.balance / totalAR : 0;
      // Dollars at risk weights older money harder; used for sort order.
      c.atRisk = c.buckets.b1 * 1 + c.buckets.b31 * 2 + c.buckets.b61 * 3 + c.buckets.b90 * 4 + c.buckets.current * 0.01;
      var h = history[c.name.toLowerCase()];
      c.history = map.paidDate ? (h || { settled: 0, late: 0 }) : null;
      c.partial = c.invoices.filter(function (i) { return i.paid > 0 && i.daysOverdue > 0; });
      c.disputed = c.invoices.filter(function (i) { return i.disputed; });

      // Tone: tier stays for routing, tone moves one step with history.
      c.tone = c.tier;
      c.toneNote = "";
      if (c.tier >= 1 && c.tier <= 4 && c.history) {
        if (c.history.late >= 2) { c.tone = Math.min(4, c.tier + 1); c.toneNote = c.history.late + " late payments in 12 months: tone firmed"; }
        else if (c.history.late === 0 && c.history.settled > 0) { c.tone = Math.max(1, c.tier - 1); c.toneNote = "No late payments in 12 months: tone softened"; }
      }

      c.action = "none";
      c.needsYou = false;
      if (c.dupes.length) c.flags.push("Duplicate invoice # in export (" + c.dupes.join(", ") + "), counted once");
      if (c.tier === 0) c.action = "list";
      else if (c.disputed.length) {
        c.action = "billing";
        c.flags.push("Disputed: billing-question reply instead of a chaser");
      } else if (c.tier === 5) {
        c.action = "none"; c.needsYou = true;
        c.flags.push(c.oldestDays + " days overdue: call suggested, no draft");
      } else c.action = "chase";

      if (c.action !== "list" && c.share > settings.arShareFlag) {
        c.needsYou = true;
        c.flags.push(Math.round(c.share * 100) + "% of total AR");
      }
      if ((c.action === "chase" || c.action === "billing") && !c.email) {
        c.action = "none"; c.needsYou = true;
        c.flags.push("No contact email in export: fix the record, no draft");
      }
    });

    list.sort(function (a, b) { return b.atRisk - a.atRisk || b.balance - a.balance; });

    var toChase = list.filter(function (c) { return c.tier >= 1; });
    var over30 = Math.round(list.reduce(function (s, c) { return s + c.over30; }, 0) * 100) / 100;
    return {
      runDate: run,
      nextRun: run + CYCLE_DAYS * DAY,
      customers: list,
      excluded: excluded,
      excludedTotal: excluded.paid + excluded.nonPositive + excluded.noDueDate + excluded.duplicate + excluded.unreadable,
      totalAR: totalAR,
      over30: over30,
      toChase: toChase.length,
      dates: dates,
      settings: settings
    };
  }

  // ---------- Drafts ----------

  function subjectFor(c, invs) {
    if (invs.length === 1) return "Invoice " + invs[0].invoice + " · " + fmtMoney(invs[0].balance) + " · " + invs[0].daysOverdue + " days overdue";
    var tot = Math.round(invs.reduce(function (s, i) { return s + i.balance; }, 0) * 100) / 100;
    return invs.length + " open invoices · " + fmtMoney(tot) + " outstanding";
  }

  function invoiceLine(i) {
    var when = i.daysOverdue > 0 ? i.daysOverdue + " days overdue" : (i.daysOverdue === 0 ? "due today" : "not yet due");
    var paidNote = i.paid > 0 ? " (" + fmtMoney(i.paid) + " received)" : "";
    return "- " + i.invoice + ": " + fmtMoney(i.balance) + " open" + paidNote + ", due " + fmtShortDate(i.dueDate) + ", " + when;
  }

  var OPENERS = {
    1: "I hope all is well. A quick note in case this one slipped through.",
    2: "I'm following up on a past-due balance on your account.",
    3: "Your account has a past-due balance that we need to resolve.",
    4: "This is a final notice on the past-due balance on your account."
  };

  // Deterministic draft. Used directly when the proxy is down, and as the reference the
  // model output is checked against. Customer names never enter the body, so a hostile
  // name in the export cannot steer the text.
  function templateDraft(c, run, settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var out = { tier: c.tier, subject: "", body: "", flags: c.flags.slice(), cc: "", to: c.email, source: "template" };
    if (c.action !== "chase" && c.action !== "billing") return out;

    var signer = c.tier === 4 ? [settings.founderName, settings.founderRole] : [settings.senderName, settings.senderRole];
    var sign = "Thanks,\n" + signer[0] + "\n" + signer[1];
    var lines = ["Hello,", ""];

    if (c.action === "billing") {
      var d = c.disputed;
      out.subject = d.length === 1 ? "Question on invoice " + d[0].invoice : "Question on " + d.length + " invoices";
      lines.push("I understand there may be a problem with " + (d.length === 1 ? "this invoice:" : "these invoices:"));
      d.forEach(function (i) { lines.push(invoiceLine(i)); });
      lines.push("", "Could you tell me what looks wrong, whether it's the amount, the line items or the PO? Once I know, I'll correct it and send a revised copy. We'll pause reminders on " + (d.length === 1 ? "it" : "them") + " until it's settled.", "", sign);
      out.body = lines.join("\n");
      return out;
    }

    var invs = c.invoices.filter(function (i) { return i.daysOverdue > 0; });
    var shown = c.tier >= 3 ? c.invoices.slice(0, 6) : invs.slice(0, 6);
    out.subject = subjectFor(c, c.tier >= 3 ? c.invoices : invs);
    if (c.tier === 3 && c.ccEmail) out.cc = c.ccEmail;

    lines.push(OPENERS[c.tone] || OPENERS[c.tier]);
    lines.push("");

    if (shown.length === 1 && c.tier <= 2) {
      var i = shown[0];
      if (i.paid > 0) {
        lines.push("Thank you for the " + fmtMoney(i.paid) + " received against invoice " + i.invoice + ". The remaining " + fmtMoney(i.balance) + " was due on " + fmtDate(i.dueDate) + " and is now " + i.daysOverdue + " days overdue.");
      } else if (c.tier === 1) {
        lines.push("Invoice " + i.invoice + " for " + fmtMoney(i.balance) + " was due on " + fmtDate(i.dueDate) + ".");
      } else {
        lines.push("Invoice " + i.invoice + " for " + fmtMoney(i.balance) + " is now " + i.daysOverdue + " days overdue (due " + fmtDate(i.dueDate) + ").");
      }
    } else {
      var partials = shown.filter(function (x) { return x.paid > 0; });
      lines.push((c.tier >= 3 ? "The total open balance is " + fmtMoney(c.balance) + ":" : "These invoices are past due:"));
      shown.forEach(function (x) { lines.push(invoiceLine(x)); });
      var rest = (c.tier >= 3 ? c.invoices.length : invs.length) - shown.length;
      if (rest > 0) lines.push("- plus " + rest + " more, listed in the attached statement");
      if (partials.length) lines.push("", "Thank you for the partial payments already received; the figures above are the remaining amounts.");
    }
    lines.push("");

    var run_ = typeof run === "number" ? run : parseDate(run);
    if (c.tier === 1) {
      lines.push(c.tone >= 2 ? "Please confirm the date this will be paid." : "Could you let me know when payment is scheduled?");
    } else if (c.tier === 2) {
      lines.push("Could you confirm a payment date by " + fmtDay(addBusinessDays(run_, 3)) + "? I'm happy to resend a copy of the invoice if that helps.");
    } else if (c.tier === 3) {
      lines.push("Please arrange payment, or confirm a payment date, by " + fmtDay(addBusinessDays(run_, 5)) + ". If a billing issue is holding this up, tell me and I'll resolve it.");
    } else if (c.tier === 4) {
      if (c.history && c.history.late > 0) lines.push("This account has had " + c.history.late + " late payment" + (c.history.late === 1 ? "" : "s") + " in the last 12 months.");
      lines.push("I'd like to agree a plan on a 15-minute call this week. What time works for you?");
    }
    lines.push("", sign);
    out.body = lines.join("\n");
    return out;
  }

  // ---------- Model I/O ----------

  /* The only data that leaves the browser: no emails, no raw rows. */
  function modelSummary(c, run, settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var run_ = typeof run === "number" ? run : parseDate(run);
    return {
      name: c.name,
      balance: c.balance,
      oldestDaysOverdue: c.oldestDays,
      tier: c.tier,
      tone: c.tone,
      action: c.action,
      terms: c.terms || null,
      lateHistory: c.history ? { settledLast12m: c.history.settled, lateLast12m: c.history.late } : null,
      invoices: c.invoices.slice(0, 8).map(function (i) {
        return { invoice: i.invoice, amount: i.amount, paid: i.paid, balance: i.balance, dueDate: isoDate(i.dueDate), daysOverdue: i.daysOverdue, disputed: i.disputed };
      }),
      subject: templateDraft(c, run_, settings).subject,
      askBy: c.tier === 2 ? fmtDay(addBusinessDays(run_, 3)) : c.tier === 3 ? fmtDay(addBusinessDays(run_, 5)) : null,
      signOff: c.tier === 4 ? settings.founderName + "\n" + settings.founderRole : settings.senderName + "\n" + settings.senderRole
    };
  }

  var BANNED = [/\blegal\b/i, /\blawyer/i, /\battorney/i, /\bcourt\b/i, /\blawsuit/i, /\bsue\b/i, /\blitigat/i, /\bcollections?\b/i, /\bcollection agency/i, /\bcredit (rating|bureau|report)/i, /\bdebt collector/i, /\binterest charge/i];

  function wordCount(s) { return String(s || "").split(/\s+/).filter(Boolean).length; }

  /* Check a draft (model or template) against the hard rules. Returns a list of problems. */
  function validateDraft(d, c, settings) {
    var problems = [];
    if (!d || typeof d.body !== "string" || typeof d.subject !== "string") return ["Malformed output"];
    var text = d.subject + "\n" + d.body;
    if (/!/.test(text)) problems.push("Contains an exclamation mark");
    if (wordCount(d.body) >= 120) problems.push("Body is " + wordCount(d.body) + " words (limit under 120)");
    BANNED.forEach(function (re) { if (re.test(text)) problems.push("Banned language: " + text.match(re)[0]); });
    var feeAllowed = /fee/i.test(c.terms || "");
    if (!feeAllowed && /\b(late|penalty|admin(istrative)?) (fee|charge)/i.test(text)) problems.push("Mentions a fee the terms don't state");
    if (/[—]/.test(text)) problems.push("Contains an em dash");

    var allowed = {};
    var add = function (n) { allowed[Math.round(n * 100)] = true; };
    c.invoices.forEach(function (i) { add(i.amount); add(i.paid); add(i.balance); });
    add(c.balance); add(c.overdueBalance);
    var re = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)(k?)/gi, m;
    while ((m = re.exec(text))) {
      var n = parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
      if (!allowed[Math.round(n * 100)]) problems.push("Figure not in input: " + m[0]);
    }
    var days = {};
    c.invoices.forEach(function (i) { days[i.daysOverdue] = true; });
    var dre = /(\d+)\s+days?\b/gi;
    while ((m = dre.exec(text))) if (!days[+m[1]]) problems.push("Day count not in input: " + m[0]);
    // Blank out the real invoice numbers first, whatever their shape (INV-2610-001 included),
    // so only invented ones are left for the pattern to find.
    var rest = text;
    c.invoices.map(function (i) { return i.invoice; }).sort(function (a, b) { return b.length - a.length; }).forEach(function (id) {
      rest = rest.replace(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
    });
    var ire = /\b[A-Z]{2,5}-?\d{3,}(?:-\d+)*\b/g;
    while ((m = ire.exec(rest))) problems.push("Invoice # not in input: " + m[0]);
    var signer = c.tier === 4 ? settings && settings.founderName : settings && settings.senderName;
    if (signer && d.body.indexOf(signer) === -1) problems.push("Missing sign-off");
    return problems;
  }

  /* Pick the model draft only when it passes every rule; otherwise use the template. */
  function chooseDraft(modelOut, c, run, settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var tpl = templateDraft(c, run, settings);
    if (c.action !== "chase" && c.action !== "billing") return tpl;
    if (!modelOut || (modelOut.flags && modelOut.flags.length && !modelOut.body)) return tpl;
    var cand = { tier: c.tier, subject: tpl.subject, body: String(modelOut.body || ""), flags: tpl.flags, cc: tpl.cc, to: tpl.to, source: "claude" };
    var problems = validateDraft(cand, c, settings);
    if (problems.length) { tpl.rejected = problems; return tpl; }
    return cand;
  }

  // ---------- Actioned ticks ----------

  /* A tick counts for the run it was made in: on or before the run date and less than one
   * 14-day cycle old. After that the customer comes back as Needs action if still flagged. */
  function tickActive(tickDate, runDate) {
    var t = parseDate(tickDate);
    return t != null && t <= runDate && runDate - t < CYCLE_DAYS * DAY;
  }

  // ---------- Digest ----------

  function slackDigest(res) {
    var needs = res.customers.filter(function (c) { return c.needsYou; });
    var drafts = res.customers.filter(function (c) { return c.action === "chase"; }).length;
    var billing = res.customers.filter(function (c) { return c.action === "billing"; }).length;
    var l1 = "AR run " + fmtShortDate(res.runDate) + ": " + fmtK(res.totalAR) + " outstanding, " + fmtK(res.over30) + " over 30 days, " + res.toChase + " customer" + (res.toChase === 1 ? "" : "s") + " to chase.";
    var l2 = needs.length
      ? "Needs action: " + needs.slice(0, 4).map(function (c) { return c.name.slice(0, 40) + " (" + fmtK(c.balance) + ", " + c.oldestDays + " days overdue)"; }).join("; ") + (needs.length > 4 ? "; +" + (needs.length - 4) + " more" : "") + "."
      : "Nothing needs action this run.";
    var l3 = "Drafts ready: " + drafts + " chaser" + (drafts === 1 ? "" : "s") + (billing ? ", " + billing + " billing repl" + (billing === 1 ? "y" : "ies") : "") + ". Next run " + fmtShortDate(res.nextRun) + ".";
    // Slack treats <, > and & as control characters; customer names are data, not markup.
    return [l1, l2, l3].join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  return {
    parseCSV: parseCSV, FIELDS: FIELDS, autoMap: autoMap, missingRequired: missingRequired,
    parseMoney: parseMoney, parseDate: parseDate, dateOrderOf: dateOrderOf, tickActive: tickActive, isoDate: isoDate, fmtDate: fmtDate, fmtShortDate: fmtShortDate, fmtDay: fmtDay,
    fmtMoney: fmtMoney, fmtK: fmtK, addBusinessDays: addBusinessDays,
    BUCKETS: BUCKETS, bucketOf: bucketOf, tierOf: tierOf, TIER_NAMES: TIER_NAMES, RUBRIC: RUBRIC, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    analyze: analyze, templateDraft: templateDraft, modelSummary: modelSummary,
    validateDraft: validateDraft, chooseDraft: chooseDraft, wordCount: wordCount, slackDigest: slackDigest
  };
});
