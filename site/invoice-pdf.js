/* Invoice PDFs, drawn directly with jsPDF so a click saves a file with no print dialog.
 * Pure: takes the jsPDF constructor, so the same code runs in the browser and in Node tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./ar.js"));
  else root.INVPDF = factory(root.AR);
})(typeof globalThis !== "undefined" ? globalThis : this, function (AR) {
  "use strict";

  var NAVY = [52, 80, 122], INK = [29, 36, 48], INK2 = [74, 83, 97], INK3 = [122, 129, 140], LINE = [226, 226, 226];
  var ORANGE_SOFT = [253, 240, 230], ORANGE_INK = [184, 90, 28];
  var W = 612, H = 792, M = 54; // US Letter, points

  function color(doc, c) { doc.setTextColor(c[0], c[1], c[2]); }

  function drawInvoice(doc, inv, run, demo) {
    var money = function (n) { return demo ? "$xx" : AR.fmtMoney(n); };
    var y = M;

    if (demo) {
      doc.setFillColor(ORANGE_SOFT[0], ORANGE_SOFT[1], ORANGE_SOFT[2]);
      doc.roundedRect(M, y, W - 2 * M, 26, 4, 4, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); color(doc, ORANGE_INK);
      doc.text("Demo invoice: fictional customer, amounts hidden. Not a real invoice.", M + 10, y + 16.5);
      y += 46;
    }

    doc.setFont("helvetica", "bold"); doc.setFontSize(26); color(doc, NAVY);
    doc.text("Invoice", M, y + 20);
    doc.setFontSize(11); color(doc, INK);
    doc.text("SnapMagic", W - M, y + 8, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); color(doc, INK3);
    doc.text("Billing", W - M, y + 21, { align: "right" });
    doc.setFontSize(10);
    doc.text(inv.number, M, y + 38);
    y += 72;

    var cols = [
      ["Bill to", [inv.customer].concat(inv.email ? [inv.email] : [])],
      ["Issued", [AR.fmtDate(inv.issueDate)]],
      ["Due", [AR.fmtDate(inv.dueDate), inv.terms]]
    ];
    if (inv.pos.length) cols.push(["PO", [inv.pos.join(", ")]]);
    var cw = (W - 2 * M) / cols.length, maxRows = 1;
    cols.forEach(function (c, i) {
      var x = M + i * cw;
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); color(doc, INK3);
      doc.text(c[0], x, y);
      c[1].forEach(function (t, j) {
        doc.setFontSize(j === 0 ? 10 : 8.5); color(doc, j === 0 ? INK : INK3);
        var lines = doc.splitTextToSize(String(t), cw - 10);
        doc.text(lines[0], x, y + 15 + j * 13);
      });
      maxRows = Math.max(maxRows, c[1].length);
    });
    y += 30 + maxRows * 13;

    // Line items
    var xQty = W - M - 170, xRate = W - M - 90, xAmt = W - M;
    doc.setFontSize(8.5); color(doc, INK3);
    doc.text("Description", M, y);
    doc.text("Qty", xQty, y, { align: "right" });
    doc.text("Rate", xRate, y, { align: "right" });
    doc.text("Amount", xAmt, y, { align: "right" });
    y += 8;
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.75);
    doc.line(M, y, W - M, y);

    inv.lines.forEach(function (l) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); color(doc, INK);
      var desc = doc.splitTextToSize(l.description, xQty - M - 40);
      var rowH = 14 * desc.length + 12;
      if (y + rowH > H - M - 60) { doc.addPage(); y = M; }
      doc.text(desc, M, y + 17);
      doc.text(Number(l.qty).toLocaleString("en-US"), xQty, y + 17, { align: "right" });
      doc.text(money(l.rate), xRate, y + 17, { align: "right" });
      doc.text(money(l.amount), xAmt, y + 17, { align: "right" });
      y += rowH;
      doc.line(M, y, W - M, y);
    });

    y += 26;
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); color(doc, INK);
    doc.text("Total due", M, y);
    doc.text(money(inv.total), xAmt, y, { align: "right" });

    y += 40;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); color(doc, INK2);
    doc.text("Service period: " + run.period.label + ". Questions about this invoice: reply to the email it came with.", M, y);
  }

  /* One PDF; one page (or more for long invoices) per invoice. */
  function build(jsPDF, invoices, run, demo) {
    var doc = new jsPDF({ unit: "pt", format: "letter" });
    invoices.forEach(function (inv, i) {
      if (i) doc.addPage();
      drawInvoice(doc, inv, run, demo);
    });
    doc.setProperties({ title: invoices.length === 1 ? invoices[0].number : "Invoices " + run.period.label, creator: "AR chaser" });
    return doc;
  }

  return { build: build };
});
