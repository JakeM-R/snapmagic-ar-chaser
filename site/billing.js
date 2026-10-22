/* Month-end billing core: contracts CSV in, this month's invoices out.
 * Works out who to bill and for how much (billing cycles, proration, usage lines),
 * flags anything to check before invoices go out, explains the change against last
 * month, and hands the issued invoices to the aging run as open AR rows.
 * No DOM, no network. Uses ar.js for CSV, money and date parsing, so both files
 * read exports the same way. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./ar.js"));
  else root.BILL = factory(root.AR);
})(typeof globalThis !== "undefined" ? globalThis : this, function (AR) {
  "use strict";

  var DAY = 86400000;
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // ---------- Columns ----------

  var FIELDS = [
    { key: "contract", label: "Contract ID", recommended: true, use: "Catches the same contract listed twice.", syn: ["contract id", "contract", "contract #", "deal id", "subscription id", "agreement id"] },
    { key: "customer", label: "Customer", required: true, use: "One invoice per customer, with a line for each contract.", syn: ["customer", "company name", "company", "customer name", "client", "account", "associated company"] },
    { key: "email", label: "Billing email", recommended: true, use: "Where the invoice goes. Without it the invoice is flagged.", syn: ["billing email", "contact email", "invoice email", "email", "bill to email", "e-mail"] },
    { key: "ccEmail", label: "AP email (cc)", use: "Copied on the invoice email.", syn: ["ap email", "accounts payable email", "finance email", "cc email", "cc"] },
    { key: "description", label: "Plan / description", use: "The invoice line text.", syn: ["description", "plan", "product", "package", "line item", "item", "service"] },
    { key: "fee", label: "Fee per bill", required: true, use: "Amount billed each cycle: the monthly fee for monthly contracts, the quarterly fee for quarterly.", syn: ["fee per bill", "fee", "monthly fee", "recurring fee", "amount", "price", "mrr"] },
    { key: "frequency", label: "Billing frequency", recommended: true, use: "Monthly, quarterly or annual, counted from the start month. Blank means monthly.", syn: ["billing frequency", "frequency", "billing cycle", "cycle", "interval", "billing period"] },
    { key: "start", label: "Start date", required: true, use: "First month billed. A mid-month start is prorated.", syn: ["start date", "contract start", "start", "effective date", "service start"] },
    { key: "end", label: "End date", recommended: true, use: "Last day of service. Sets the final invoice and the renewal heads-up.", syn: ["end date", "contract end", "end", "term end", "renewal date", "service end"] },
    { key: "po", label: "PO number", use: "Printed on the invoice.", syn: ["po number", "po", "po #", "purchase order", "purchase order number"] },
    { key: "poRequired", label: "PO required", use: "Yes means a missing PO is flagged before sending.", syn: ["po required", "requires po", "po needed"] },
    { key: "terms", label: "Terms", use: "Sets the due date. Blank means Net 30.", syn: ["terms", "payment terms", "net terms"] },
    { key: "units", label: "Usage units", use: "Adds a usage line: units × unit price.", syn: ["usage units", "units", "usage", "quantity", "overage units", "usage quantity"] },
    { key: "unitPrice", label: "Unit price", use: "Price per usage unit.", syn: ["unit price", "usage rate", "rate", "overage rate", "price per unit"] },
    { key: "lastBilled", label: "Last month billed", recommended: true, use: "Builds the bridge from last month's total to this one.", syn: ["last month billed", "last month", "last month amount", "previous amount", "last invoiced", "prior month"] }
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

  // ---------- Helpers ----------

  function r2(n) { return Math.round(n * 100) / 100; }

  /* "2026-10", {year, month} (month 0-11) or a timestamp in the month. */
  function periodOf(p) {
    var y, m;
    if (typeof p === "string") { var mm = p.match(/^(\d{4})-(\d{1,2})/); if (!mm) return null; y = +mm[1]; m = +mm[2] - 1; }
    else if (typeof p === "number") { var d = new Date(p); y = d.getUTCFullYear(); m = d.getUTCMonth(); }
    else if (p && p.year != null) { y = p.year; m = p.month; }
    else return null;
    var start = Date.UTC(y, m, 1), end = Date.UTC(y, m + 1, 0);
    return { year: y, month: m, start: start, end: end, days: Math.round((end - start) / DAY) + 1, label: MONTHS[m] + " " + y, key: y + "-" + (m < 9 ? "0" : "") + (m + 1) };
  }

  function monthLabel(y, m) { var d = new Date(Date.UTC(y, m, 1)); return MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); }
  function shortMonth(y, m) { var d = new Date(Date.UTC(y, m, 1)); return MONTHS[d.getUTCMonth()].slice(0, 3) + " " + d.getUTCFullYear(); }

  function freqOf(v) {
    var s = norm(v);
    if (!s || /month/.test(s)) return { key: "monthly", months: 1, label: "Monthly" };
    if (/quarter|3 month/.test(s)) return { key: "quarterly", months: 3, label: "Quarterly" };
    if (/annual|year|12 month/.test(s)) return { key: "annual", months: 12, label: "Annual" };
    return null;
  }

  function termsDays(t) {
    var s = String(t || "");
    var m = s.match(/net\s*(\d+)/i);
    if (m) return +m[1];
    if (/receipt|immediate/i.test(s)) return 0;
    return 30;
  }

  function yes(v) { return /^(y|yes|true|1|required)$/i.test(String(v || "").trim()); }

  var DEFAULTS = { prefix: "INV-", startSeq: 1, renewalDays: 60, changeFlag: 0.25 };

  // ---------- The run ----------

  /* Build the month's billing: invoices grouped by customer, skipped contracts with reasons,
   * flags, and a bridge from last month's total. */
  function billingRun(rows, map, period, settings) {
    settings = Object.assign({}, DEFAULTS, settings || {});
    var P = periodOf(period);
    var g = function (r, k) { return map[k] ? r[map[k]] : ""; };
    var ym = P.year * 12 + P.month;
    var contracts = [], skipped = [], unreadable = 0, seen = {};

    rows.forEach(function (r) {
      var name = String(g(r, "customer") || "").trim();
      var fee = AR.parseMoney(g(r, "fee"));
      var id = String(g(r, "contract") || "").trim();
      var desc = String(g(r, "description") || "").trim() || "Subscription";
      if (!name || fee == null) { unreadable++; return; }
      var last = map.lastBilled ? (AR.parseMoney(g(r, "lastBilled")) || 0) : null;
      var base = { id: id, customer: name, description: desc, last: last };

      var key = (id || name + "|" + desc).toLowerCase();
      if (seen[key]) { skipped.push(Object.assign(base, { reason: "Duplicate of " + (id || desc) + " in the file, billed once", kind: "duplicate", needsYou: true, last: 0 })); return; }
      seen[key] = true;

      var start = AR.parseDate(g(r, "start"));
      var end = AR.parseDate(g(r, "end"));
      var freq = freqOf(g(r, "frequency"));
      if (start == null) { skipped.push(Object.assign(base, { reason: "No start date: fix the record", kind: "data", needsYou: true })); return; }
      if (!freq) { skipped.push(Object.assign(base, { reason: "Billing frequency “" + g(r, "frequency") + "” not recognised: use monthly, quarterly or annual", kind: "data", needsYou: true })); return; }
      if (end != null && end < start) { skipped.push(Object.assign(base, { reason: "End date is before the start date: fix the record", kind: "data", needsYou: true })); return; }
      if (start > P.end) { skipped.push(Object.assign(base, { reason: "Starts " + AR.fmtDate(start) + ", nothing to bill yet", kind: "future" })); return; }
      if (end != null && end < P.start) { skipped.push(Object.assign(base, { reason: "Ended " + AR.fmtDate(end), kind: "ended" })); return; }

      var sd = new Date(start), sYm = sd.getUTCFullYear() * 12 + sd.getUTCMonth();
      var elapsed = ym - sYm;
      var onCycle = elapsed % freq.months === 0;

      var units = map.units ? AR.parseMoney(g(r, "units")) : null;
      var price = map.unitPrice ? AR.parseMoney(g(r, "unitPrice")) : null;
      var usage = units && units > 0 && price && price > 0 ? r2(units * price) : 0;

      if (!onCycle && !usage) {
        var next = sYm + (Math.floor(elapsed / freq.months) + 1) * freq.months;
        skipped.push(Object.assign(base, { reason: freq.label + ": next bill " + monthLabel(Math.floor(next / 12), next % 12), kind: "offcycle" }));
        return;
      }

      var lines = [], flags = [], notes = [];
      var isNew = start >= P.start, isFinal = end != null && end <= P.end;
      var amount = 0;
      if (onCycle) {
        amount = fee;
        var covered = null;
        if (freq.months === 1 && (isNew || isFinal)) {
          var from = Math.max(start, P.start), to = Math.min(end == null ? P.end : end, P.end);
          covered = Math.round((to - from) / DAY) + 1;
          if (covered < P.days) amount = r2(fee * covered / P.days);
          else covered = null;
        }
        var span = freq.months === 1 ? P.label
          : shortMonth(P.year, P.month) + " – " + shortMonth(P.year, P.month + freq.months - 1);
        lines.push({ description: desc + " · " + span + (covered ? " (" + covered + " of " + P.days + " days)" : ""), qty: 1, rate: amount, amount: amount });
        if (covered) notes.push("Prorated: " + covered + " of " + P.days + " days");
      }
      if (usage) lines.push({ description: "Usage · " + P.label + " · " + units.toLocaleString("en-US") + " units", qty: units, rate: price, amount: usage });

      if (isNew) notes.push("New contract: first invoice");
      if (isFinal) notes.push("Contract ends " + AR.fmtDate(end) + ": final invoice");
      else if (end != null && end - P.end <= settings.renewalDays * DAY) notes.push("Contract ends " + AR.fmtDate(end) + ": start the renewal conversation");
      if (freq.months > 1 && onCycle) notes.push(freq.label + " bill, covers " + freq.months + " months");

      var po = String(g(r, "po") || "").trim();
      if (yes(g(r, "poRequired")) && !po) flags.push("PO required but none on file: their AP will likely reject it");

      var total = r2(lines.reduce(function (s, l) { return s + l.amount; }, 0));
      // A swing that the contract itself doesn't explain is worth a look before it goes out.
      if (last != null && last > 0 && !isNew && !isFinal && freq.months === 1) {
        var chg = (total - last) / last;
        if (Math.abs(chg) >= settings.changeFlag) flags.push("Billed " + (chg > 0 ? "up " : "down ") + Math.round(Math.abs(chg) * 100) + "% on last month: check before sending");
      }

      contracts.push({
        id: id, customer: name, email: String(g(r, "email") || "").trim(), ccEmail: String(g(r, "ccEmail") || "").trim(),
        description: desc, freq: freq, start: start, end: end, po: po, terms: String(g(r, "terms") || "").trim() || "Net 30",
        lines: lines, total: total, usage: usage, last: last, isNew: isNew, isFinal: isFinal, onCycle: onCycle, flags: flags, notes: notes
      });
    });

    // One invoice per customer, a line for each contract.
    var byCust = {};
    contracts.forEach(function (c) {
      var k = c.customer.toLowerCase();
      var inv = byCust[k] || (byCust[k] = { customer: c.customer, email: "", ccEmail: "", terms: c.terms, pos: [], lines: [], flags: [], notes: [], contracts: [] });
      if (!inv.email && c.email) inv.email = c.email;
      if (!inv.ccEmail && c.ccEmail) inv.ccEmail = c.ccEmail;
      if (c.po && inv.pos.indexOf(c.po) === -1) inv.pos.push(c.po);
      inv.lines = inv.lines.concat(c.lines);
      c.flags.forEach(function (f) { if (inv.flags.indexOf(f) === -1) inv.flags.push(f); });
      c.notes.forEach(function (f) { if (inv.notes.indexOf(f) === -1) inv.notes.push(f); });
      inv.contracts.push(c);
    });
    var invoices = Object.keys(byCust).map(function (k) { return byCust[k]; })
      .sort(function (a, b) { return a.customer.localeCompare(b.customer); });

    var yymm = String(P.year).slice(2) + (P.month < 9 ? "0" : "") + (P.month + 1);
    invoices.forEach(function (inv, i) {
      var seq = settings.startSeq + i;
      inv.number = settings.prefix + yymm + "-" + (seq < 10 ? "00" : seq < 100 ? "0" : "") + seq;
      inv.issueDate = P.end;
      inv.dueDate = P.end + termsDays(inv.terms) * DAY;
      inv.total = r2(inv.lines.reduce(function (s, l) { return s + l.amount; }, 0));
      if (!inv.email) inv.flags.unshift("No billing email: can't send until the record is fixed");
      inv.needsYou = inv.flags.length > 0;
    });

    var total = r2(invoices.reduce(function (s, i) { return s + i.total; }, 0));
    return {
      period: P, invoices: invoices, skipped: skipped, unreadable: unreadable,
      total: total, bridge: bridgeOf(contracts, skipped, map.lastBilled),
      needsYou: invoices.filter(function (i) { return i.needsYou; }).length + skipped.filter(function (s) { return s.needsYou; }).length
    };
  }

  /* Last month's total to this month's, contract by contract. Every dollar of change gets a reason. */
  function bridgeOf(contracts, skipped, hasLast) {
    if (!hasLast) return null;
    var items = [];
    contracts.forEach(function (c) {
      var d = r2(c.total - (c.last || 0));
      if (!d) return;
      var reason = c.isNew ? "New contract" + (c.notes.some(function (n) { return /Prorated/.test(n); }) ? ", prorated" : "")
        : c.isFinal && d < 0 ? "Final month, prorated"
        : c.freq.months > 1 && c.onCycle ? c.freq.label + " bill"
        : !c.onCycle ? "Usage only, off-cycle"
        : c.usage ? "Usage"
        : "Price change";
      items.push({ customer: c.customer, contract: c.id || c.description, reason: reason, delta: d });
    });
    skipped.forEach(function (s) {
      if (!s.last) return;
      var reason = s.kind === "ended" ? "Contract ended" : s.kind === "offcycle" ? "Off-cycle this month" : s.kind === "data" ? "Not billed: record needs fixing" : "Not billed";
      items.push({ customer: s.customer, contract: s.id || s.description, reason: reason, delta: -s.last });
    });
    items.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    var last = r2(contracts.reduce(function (s, c) { return s + (c.last || 0); }, 0) + skipped.reduce(function (s, x) { return s + (x.last || 0); }, 0));
    var now = r2(contracts.reduce(function (s, c) { return s + c.total; }, 0));
    return { last: last, now: now, change: r2(now - last), items: items };
  }

  // ---------- Outputs ----------

  function q(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function usDate(t) { var d = new Date(t); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "/" + d.getUTCFullYear(); }

  /* One row per invoice line, laid out for QuickBooks Online's invoice import. */
  function importCSV(run) {
    var head = ["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Memo", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount"];
    var out = [head.join(",")];
    run.invoices.forEach(function (inv) {
      inv.lines.forEach(function (l) {
        out.push([inv.number, inv.customer, usDate(inv.issueDate), usDate(inv.dueDate), inv.terms, inv.pos.length ? "PO " + inv.pos.join(", ") : "",
          l.description, l.qty, l.rate.toFixed(2), l.amount.toFixed(2)].map(q).join(","));
      });
    });
    return out.join("\n") + "\n";
  }

  /* The issued invoices as open AR records, keyed by ar.js field names. */
  function arRecords(run) {
    return run.invoices.map(function (inv) {
      return { invoice: inv.number, customer: inv.customer, email: inv.email, ccEmail: inv.ccEmail, amount: inv.total.toFixed(2), paid: "0.00",
        issueDate: AR.isoDate(inv.issueDate), dueDate: AR.isoDate(inv.dueDate), status: "Open", terms: inv.terms };
    });
  }

  var AR_HEADERS = { invoice: "Invoice number", customer: "Company name", email: "Contact email", ccEmail: "AP email", amount: "Amount", paid: "Amount paid", issueDate: "Invoice date", dueDate: "Due date", status: "Status", terms: "Terms" };

  /* Same records as a CSV in the AR chaser's own template layout. */
  function arCSV(run) {
    var keys = Object.keys(AR_HEADERS);
    return [keys.map(function (k) { return AR_HEADERS[k]; }).join(",")].concat(arRecords(run).map(function (r) {
      return keys.map(function (k) { return q(r[k]); }).join(",");
    })).join("\n") + "\n";
  }

  /* Short cover email for the invoice. Figures come from the invoice only. */
  function coverEmail(inv, run, settings) {
    settings = Object.assign({}, AR.DEFAULT_SETTINGS, settings || {});
    var body = ["Hello,", "", "Please find attached invoice " + inv.number + " for " + run.period.label + ".", "",
      "- Amount: " + AR.fmtMoney(inv.total),
      "- Due: " + AR.fmtDate(inv.dueDate) + " (" + inv.terms + ")"];
    if (inv.pos.length) body.push("- PO: " + inv.pos.join(", "));
    var extra = [];
    if (inv.notes.some(function (n) { return /New contract/.test(n); })) extra.push(inv.notes.some(function (n) { return /Prorated/.test(n); }) ? "This is the first invoice under your new contract, prorated from the start date." : "This is the first invoice under your new contract.");
    if (inv.notes.some(function (n) { return /final invoice/.test(n); })) extra.push("This is the final invoice under the current contract.");
    if (inv.lines.some(function (l) { return /^Usage/.test(l.description); })) extra.push("Usage is itemised on the invoice.");
    if (extra.length) body.push("", extra.join(" "));
    body.push("", "If anything needs correcting before your team processes it, reply here and I'll reissue it.", "", "Thanks,", settings.senderName, settings.senderRole);
    return {
      to: inv.email, cc: inv.ccEmail,
      subject: "Invoice " + inv.number + " · " + run.period.label + " · " + AR.fmtMoney(inv.total),
      body: body.join("\n")
    };
  }

  return {
    FIELDS: FIELDS, autoMap: autoMap, missingRequired: missingRequired, periodOf: periodOf, freqOf: freqOf, termsDays: termsDays,
    billingRun: billingRun, importCSV: importCSV, arRecords: arRecords, arCSV: arCSV, AR_HEADERS: AR_HEADERS, coverEmail: coverEmail, DEFAULTS: DEFAULTS
  };
});
