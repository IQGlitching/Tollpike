// A minimal text-to-PDF writer, for evidence uploads.
//
// Compliance platforms accept PDFs everywhere and Markdown or JSON only
// sometimes, so the evidence pack goes up as a PDF. This writes a valid
// PDF 1.4 with the standard Courier font: plain monospaced text, wrapped,
// paginated. No dependency, no images, no layout engine. The JSON pack is
// the machine-readable copy; this is the one a person opens.

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const FONT_SIZE = 9;
const LEADING = 12;
const COLS = Math.floor((PAGE_W - 2 * MARGIN) / (FONT_SIZE * 0.6));
const ROWS = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);

// Courier in the standard encoding covers Latin-1. Anything else is replaced
// rather than emitted as bytes the viewer would render as garbage.
function latin1(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/·/g, "·")
    .replace(/→/g, "->")
    .replace(/✓/g, "OK")
    .replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ]/g, "?");
}

function escapePdf(line) {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text) {
  const out = [];
  for (const raw of latin1(text).replace(/\t/g, "  ").split(/\r?\n/)) {
    let line = raw;
    if (!line.length) { out.push(""); continue; }
    while (line.length > COLS) {
      let cut = line.lastIndexOf(" ", COLS);
      if (cut < COLS * 0.5) cut = COLS;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, "");
    }
    out.push(line);
  }
  return out;
}

/** Text in, a PDF Buffer out. `title` goes in the document info. */
export function textToPdf(text, { title = "Tollpike audit evidence" } = {}) {
  const lines = wrap(text);
  const pages = [];
  for (let i = 0; i < lines.length; i += ROWS) pages.push(lines.slice(i, i + ROWS));
  if (!pages.length) pages.push([""]);

  const objects = []; // index n holds object n+1
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogId = add(null); // filled once the page tree id is known
  const pagesId = add(null);
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const pageIds = [];
  pages.forEach((pageLines, p) => {
    const body = [`BT /F1 ${FONT_SIZE} Tf ${LEADING} TL ${MARGIN} ${PAGE_H - MARGIN} Td`];
    for (const l of pageLines) body.push(`(${escapePdf(l)}) Tj T*`);
    body.push("ET");
    body.push(`BT /F1 7 Tf ${MARGIN} ${MARGIN / 2} Td (${escapePdf(`${latin1(title)} - page ${p + 1} of ${pages.length}`)}) Tj ET`);
    const stream = body.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Title (${escapePdf(latin1(title))}) /Producer (Tollpike) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z) >>`);

  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
