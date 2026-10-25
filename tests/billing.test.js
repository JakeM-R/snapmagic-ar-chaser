// Month-end billing run: cycles, proration, usage, flags, the bridge and the hand-off to aging.
const test = require("node:test");
const assert = require("node:assert");
const AR = require("../site/ar.js");
const BILL = require("../site/billing.js");
const DEMO = require("../site/demo.js");

const OCT = "2026-10";
const HEAD = "Contract ID,Company name,Billing email,Description,Fee per bill,Billing frequency,Start date,End date,PO number,PO required,Usage units,Unit price,Terms,Last month billed";
function bill(lines, period = OCT) {
  const p = AR.parseCSV([HEAD, ...lines].join("\n"));
  return BILL.billingRun(p.rows, BILL.autoMap(p.headers), period);
}
const inv = (run, name) => run.invoices.find((i) => i.customer === name);

test("a steady monthly contract bills its fee, issued on the 31st and due on Net 30", () => {
  const run = bill(["C-1,Acme,ap@acme.example,Placement,2400,Monthly,2026-01-01,,,,,,Net 30,2400"]);
  const i = inv(run, "Acme");
  assert.strictEqual(i.total, 2400);
  assert.strictEqual(i.number, "INV-2610-001");
  assert.strictEqual(AR.isoDate(i.issueDate), "2026-10-31");
  assert.strictEqual(AR.isoDate(i.dueDate), "2026-11-30");
  assert.strictEqual(i.needsYou, false);
});

test("a mid-month start is prorated by days covered and noted as new", () => {
  const i = inv(bill(["C-1,Acme,ap@acme.example,Placement,3100,Monthly,2026-10-15,,,,,,Net 30,"]), "Acme");
  assert.strictEqual(i.total, 1700); // 17 of 31 days
  assert.ok(i.notes.some((n) => /Prorated: 17 of 31 days/.test(n)));
  assert.ok(i.notes.some((n) => /New contract/.test(n)));
});

test("quarterly bills every third month from the start month; annual on the anniversary", () => {
  const run = bill([
    "Q-1,On cycle,a@x.example,Build,9000,Quarterly,2026-04-01,,,,,,Net 30,",
    "Q-2,Off cycle,b@x.example,Build,6000,Quarterly,2026-06-01,,,,,,Net 30,",
    "A-1,Annual,c@x.example,Licence,18000,Annual,2025-10-01,,,,,,Net 30,"
  ]);
  assert.strictEqual(inv(run, "On cycle").total, 9000);
  assert.strictEqual(inv(run, "Annual").total, 18000);
  assert.ok(!inv(run, "Off cycle"));
  assert.match(run.skipped.find((s) => s.customer === "Off cycle").reason, /next bill December 2026/);
});

test("usage adds its own line, and two contracts for one customer share one invoice", () => {
  const run = bill([
    "C-1,Acme,ap@acme.example,Placement,5000,Monthly,2026-01-01,,PO-9,Yes,1240,1.50,Net 30,",
    "C-2,Acme,ap@acme.example,Insights,1500,Monthly,2026-01-01,,PO-9,Yes,,,Net 30,"
  ]);
  assert.strictEqual(run.invoices.length, 1);
  const i = inv(run, "Acme");
  assert.strictEqual(i.lines.length, 3);
  assert.strictEqual(i.total, 8360);
  assert.deepStrictEqual(i.pos, ["PO-9"]);
});

test("ended and future contracts are not billed; final month and renewal are noted", () => {
  const run = bill([
    "C-1,Ended,a@x.example,P,1000,Monthly,2026-01-01,2026-09-30,,,,,Net 30,1000",
    "C-2,Future,b@x.example,P,1000,Monthly,2026-11-01,,,,,,Net 30,",
    "C-3,Final,c@x.example,P,1000,Monthly,2026-01-01,2026-10-31,,,,,Net 30,1000",
    "C-4,Renewing,d@x.example,P,1000,Monthly,2026-01-01,2026-11-30,,,,,Net 30,1000"
  ]);
  assert.ok(!inv(run, "Ended") && !inv(run, "Future"));
  assert.ok(inv(run, "Final").notes.some((n) => /final invoice/.test(n)));
  assert.ok(inv(run, "Renewing").notes.some((n) => /renewal/.test(n)));
});

test("missing email, missing required PO and an unexplained 25% swing are flagged", () => {
  const run = bill([
    "C-1,No email,,P,1000,Monthly,2026-01-01,,,,,,Net 30,1000",
    "C-2,No PO,a@x.example,P,1000,Monthly,2026-01-01,,,Yes,,,Net 30,1000",
    "C-3,Swing,b@x.example,P,1500,Monthly,2026-01-01,,,,,,Net 30,1000"
  ]);
  assert.ok(inv(run, "No email").flags.some((f) => /No billing email/.test(f)));
  assert.ok(inv(run, "No PO").flags.some((f) => /PO required/.test(f)));
  assert.ok(inv(run, "Swing").flags.some((f) => /up 50%/.test(f)));
  assert.strictEqual(run.needsYou, 3);
});

test("a duplicate contract is billed once; bad rows are skipped with a reason, not guessed", () => {
  const run = bill([
    "C-1,Acme,a@x.example,P,1000,Monthly,2026-01-01,,,,,,Net 30,",
    "C-1,Acme,a@x.example,P,1000,Monthly,2026-01-01,,,,,,Net 30,",
    "C-2,No start,b@x.example,P,1000,Monthly,,,,,,,Net 30,",
    "C-3,Weird,c@x.example,P,1000,Fortnightly,2026-01-01,,,,,,Net 30,",
    "C-4,,c@x.example,P,1000,Monthly,2026-01-01,,,,,,Net 30,"
  ]);
  assert.strictEqual(inv(run, "Acme").total, 1000);
  assert.ok(run.skipped.some((s) => /Duplicate/.test(s.reason)));
  assert.ok(run.skipped.some((s) => /No start date/.test(s.reason)));
  assert.ok(run.skipped.some((s) => /not recognised/.test(s.reason)));
  assert.strictEqual(run.unreadable, 1);
});

test("Net 45 and due-on-receipt terms set the due date", () => {
  const run = bill([
    "C-1,N45,a@x.example,P,1000,Monthly,2026-01-01,,,,,,Net 45,",
    "C-2,Receipt,b@x.example,P,1000,Monthly,2026-01-01,,,,,,Due on receipt,"
  ]);
  assert.strictEqual(AR.isoDate(inv(run, "N45").dueDate), "2026-12-15");
  assert.strictEqual(AR.isoDate(inv(run, "Receipt").dueDate), "2026-10-31");
});

test("demo: the bridge from last month to this month reconciles to the cent", () => {
  const P = BILL.periodOf(OCT).start;
  const p = AR.parseCSV(DEMO.contractsCSV(P));
  const run = BILL.billingRun(p.rows, BILL.autoMap(p.headers), P);
  assert.deepStrictEqual(BILL.missingRequired(BILL.autoMap(p.headers)), []);
  assert.strictEqual(run.invoices.length, 10);
  const br = run.bridge;
  const sum = br.items.reduce((s, i) => s + i.delta, 0);
  assert.strictEqual(Math.round((br.last + sum) * 100), Math.round(br.now * 100));
  assert.strictEqual(br.now, run.total);
  assert.strictEqual(run.needsYou, 2);
});

test("hand-off: issued invoices age as open AR and the QuickBooks file has one row per line", () => {
  const P = BILL.periodOf(OCT).start;
  const p = AR.parseCSV(DEMO.contractsCSV(P));
  const run = BILL.billingRun(p.rows, BILL.autoMap(p.headers), P);

  const ar = AR.parseCSV(BILL.arCSV(run));
  const before = AR.analyze(ar.rows, AR.autoMap(ar.headers), Date.UTC(2026, 10, 15));
  assert.strictEqual(before.toChase, 0); // not due yet
  assert.strictEqual(before.totalAR, run.total);
  const after = AR.analyze(ar.rows, AR.autoMap(ar.headers), Date.UTC(2026, 11, 10));
  assert.ok(after.customers.filter((c) => c.tier === 1).length >= 8); // 10 days overdue: tier 1

  const qbo = AR.parseCSV(BILL.importCSV(run));
  assert.strictEqual(qbo.rows.length, run.invoices.reduce((s, i) => s + i.lines.length, 0));
  assert.strictEqual(qbo.rows[0].InvoiceDate, "10/31/2026");
  const sum = qbo.rows.reduce((s, r) => s + parseFloat(r.ItemAmount), 0);
  assert.strictEqual(Math.round(sum * 100), Math.round(run.total * 100));
});

test("cover email states amount, due date and PO, and passes the chaser draft rules", () => {
  const run = bill(["C-1,Acme,ap@acme.example,Placement,2400,Monthly,2026-01-01,,PO-77,Yes,,,Net 30,2400"]);
  const e = BILL.coverEmail(inv(run, "Acme"), run, AR.DEFAULT_SETTINGS);
  assert.strictEqual(e.subject, "Invoice INV-2610-001 · October 2026 · $2,400");
  assert.match(e.body, /Due: November 30, 2026 \(Net 30\)/);
  assert.match(e.body, /PO: PO-77/);
  assert.ok(!/!/.test(e.body));
  assert.ok(AR.wordCount(e.body) < 120);
});

test("invoice PDF: one page per invoice, real figures when not demo, masked in demo", () => {
  const { jsPDF } = require("../site/vendor/jspdf-2.5.1.umd.min.js");
  const INVPDF = require("../site/invoice-pdf.js");
  const run = bill([
    "C-1,Acme,ap@acme.example,Placement,2400,Monthly,2026-01-01,,PO-77,Yes,,,Net 30,",
    "C-2,Beta,b@x.example,Placement,1000,Monthly,2026-01-01,,,,,,Net 30,"
  ]);
  const doc = INVPDF.build(jsPDF, run.invoices, run, false);
  assert.strictEqual(doc.getNumberOfPages(), 2);
  doc.setProperties({ creationDate: new Date(0) });
  const raw = doc.output();
  assert.match(raw, /INV-2610-001/);
  assert.match(raw, /\$2,400/);
  assert.match(raw, /PO-77/);
  const demo = INVPDF.build(jsPDF, run.invoices, run, true).output();
  assert.ok(!/\$2,400/.test(demo));
  assert.match(demo, /Demo invoice/);
});

test("quarterly and annual bills are prorated when the contract starts or ends inside the cycle", () => {
  const run = bill([
    "Q-1,Ends early,a@x.example,Build,9200,Quarterly,2026-10-01,2026-11-15,,,,,Net 30,",
    "A-1,Starts late,b@x.example,Licence,36500,Annual,2026-10-20,,,,,,Net 30,"
  ]);
  const q = inv(run, "Ends early");
  assert.strictEqual(q.total, 4600); // Oct 1 to Nov 15: 46 of 92 days
  assert.match(q.lines[0].description, /46 of 92 days/);
  assert.ok(q.notes.some((n) => /final invoice/.test(n)));
  const a = inv(run, "Starts late");
  assert.strictEqual(a.total, 34600); // Oct 20 2026 to Sep 30 2027: 346 of 365 days
  assert.match(a.lines[0].description, /346 of 365 days/);
});

test("one customer's contracts on different terms get separate invoices with their own due dates", () => {
  const run = bill([
    "C-1,Acme,ap@acme.example,Placement,1000,Monthly,2026-01-01,,,,,,Net 15,",
    "C-2,Acme,ap@acme.example,Insights,500,Monthly,2026-01-01,,,,,,Net 60,"
  ]);
  const acme = run.invoices.filter((i) => i.customer === "Acme");
  assert.strictEqual(acme.length, 2);
  assert.deepStrictEqual(acme.map((i) => AR.isoDate(i.dueDate)), ["2026-11-15", "2026-12-30"]);
  assert.deepStrictEqual(acme.map((i) => i.number), ["INV-2610-001", "INV-2610-002"]);
  assert.ok(acme.every((i) => i.notes.some((n) => /Split by payment terms/.test(n))));
  assert.strictEqual(run.total, 1500);
});

test("day-first contract dates are read day first, and an unreadable date is skipped, not guessed", () => {
  const run = bill([
    "C-1,Acme,ap@acme.example,Placement,3100,Monthly,15/10/2026,,,,,,Net 30,",
    "C-2,Bad,b@x.example,Placement,1000,Monthly,31/02/2026,,,,,,Net 30,"
  ]);
  assert.strictEqual(run.dates.order, "dmy");
  assert.strictEqual(inv(run, "Acme").total, 1700); // 17 of 31 days
  assert.ok(run.skipped.some((s) => s.customer === "Bad" && /can't be read/.test(s.reason)));
});
