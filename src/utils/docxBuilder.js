// Minimal .docx writer (WordprocessingML in a zip). Only what the planning
// report needs: headings, paragraphs, bullet lines, tables, PNG images and page
// breaks. Pure apart from JSZip, so it runs in the browser and in tests.
import JSZip from "jszip";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const EMU_PER_PX = 9525;
const TEXT_WIDTH_TWIPS = 9026; // A4 with 1 inch margins

export const escapeXml = (value) =>
  String(value ?? "")
    // control characters are not allowed in XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const run = (text, { bold, italic, size, color, font } = {}) =>
  `<w:r><w:rPr>${font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : ""}${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}${
    color ? `<w:color w:val="${color}"/>` : ""
  }${size ? `<w:sz w:val="${size * 2}"/>` : ""}</w:rPr><w:t xml:space="preserve">${escapeXml(
    text,
  )}</w:t></w:r>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3F3A"/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3F3A"/><w:sz w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2F6F62"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="35504A"/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;

export class DocxBuilder {
  constructor() {
    this.body = [];
    this.media = []; // { name, bytes }
    this.headings = []; // { text, level } for the contents list
    this.header = null; // { header, footer } text, see setHeaderFooter
  }

  // Running header and footer (with page numbers). The first page, the cover,
  // has none.
  // logos: { left, right }, each { bytes (PNG), widthPx, heightPx } or null; they
  // are shown in a line above the header text (company left, tool right).
  setHeaderFooter({ header = "", footer = "", logos = null } = {}) {
    this.header = { header, footer, logos };
    return this;
  }

  // Shaded call-out: kind is "info", "warn" (a caution) or "missing" (data
  // the project does not have).
  note(text, kind = "info") {
    const fill = { info: "E8F3EF", warn: "FFF4E0", missing: "EEF0F3" }[kind] || "E8F3EF";
    const bar = { info: "2F6F62", warn: "D97706", missing: "6B7280" }[kind] || "2F6F62";
    this.body.push(
      `<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="6" w:color="${bar}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:spacing w:before="60" w:after="140"/><w:ind w:left="140" w:right="80"/></w:pPr>${run(text, { size: 10 })}</w:p>`,
    );
    return this;
  }

  caption(text) {
    this.body.push(
      `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr>${run(text, { italic: true, size: 9, color: "6B7280" })}</w:p>`,
    );
    return this;
  }

  // Where the contents list goes; it is filled in when the file is written.
  toc() {
    this.body.push("@@TOC@@");
    return this;
  }

  title(text) {
    this.body.push(
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run(text)}</w:p>`,
    );
    return this;
  }

  heading(text, level = 1) {
    this.headings.push({ text, level });
    this.body.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${run(text)}</w:p>`,
    );
    return this;
  }

  // `text` is a string or an array of [text, options] pieces.
  paragraph(text, options = {}) {
    const pieces = Array.isArray(text) ? text : [[text, options]];
    const align = options.align
      ? `<w:jc w:val="${options.align}"/>`
      : "";
    const keep = options.keepNext ? "<w:keepNext/>" : "";
    this.body.push(
      `<w:p><w:pPr>${keep}${align}</w:pPr>${pieces
        .map(([t, o]) => run(t, o))
        .join("")}</w:p>`,
    );
    return this;
  }

  bullet(text, options = {}) {
    this.body.push(
      `<w:p><w:pPr><w:spacing w:after="${options.after ?? 40}"/><w:ind w:left="360" w:hanging="240"/></w:pPr>${run(
        "•  ",
        options,
      )}${run(text, options)}</w:p>`,
    );
    return this;
  }

  pageBreak() {
    this.body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    return this;
  }

  // rows[0] is the header row. `widths` are relative column weights.
  table(rows, widths) {
    if (!rows.length) return this;
    const cols = rows[0].length;
    const weights = widths || Array(cols).fill(1);
    const total = weights.reduce((a, b) => a + b, 0);
    const twips = weights.map((w) => Math.round((w / total) * TEXT_WIDTH_TWIPS));
    const border = (name) =>
      `<w:${name} w:val="single" w:sz="4" w:space="0" w:color="C9D8D2"/>`;
    const cell = (text, i, header, shaded) =>
      `<w:tc><w:tcPr><w:tcW w:w="${twips[i]}" w:type="dxa"/>${
        header
          ? '<w:shd w:val="clear" w:color="auto" w:fill="1F3F3A"/>'
          : shaded
            ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F7F5"/>'
            : ""
      }</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${run(
        text,
        header ? { bold: true, color: "FFFFFF", size: 10 } : { size: 10 },
      )}</w:p></w:tc>`;
    const xml =
      `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_WIDTH_TWIPS}" w:type="dxa"/><w:tblBorders>${[
        "top",
        "left",
        "bottom",
        "right",
        "insideH",
        "insideV",
      ]
        .map(border)
        .join("")}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>` +
      `<w:tblGrid>${twips.map((t) => `<w:gridCol w:w="${t}"/>`).join("")}</w:tblGrid>` +
      rows
        .map(
          (row, r) =>
            `<w:tr>${r === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "<w:trPr><w:cantSplit/></w:trPr>"}${row
              .map((c, i) => cell(c ?? "", i, r === 0, r % 2 === 0))
              .join("")}</w:tr>`,
        )
        .join("") +
      "</w:tbl><w:p/>";
    this.body.push(xml);
    return this;
  }

  // PNG bytes (Uint8Array) with their pixel size; scaled to `maxWidthPx`.
  image(bytes, widthPx, heightPx, alt = "", maxWidthPx = 600) {
    const scale = Math.min(1, maxWidthPx / widthPx);
    const cx = Math.round(widthPx * scale * EMU_PER_PX),
      cy = Math.round(heightPx * scale * EMU_PER_PX);
    const n = this.media.length + 1;
    this.media.push({ name: `image${n}.png`, bytes });
    this.body.push(
      `<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${escapeXml(
        alt,
      )}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
    );
    return this;
  }

  tocXml() {
    const entries = this.headings.filter((h) => h.level <= 2);
    if (!entries.length) return "";
    const lines = entries.map((h, i) => {
      const first =
        i === 0
          ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
          : "";
      const last =
        i === entries.length - 1
          ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
          : "";
      return `<w:p><w:pPr><w:spacing w:after="40"/><w:ind w:left="${h.level === 1 ? 0 : 360}"/></w:pPr>${first}${run(h.text, { bold: h.level === 1, size: h.level === 1 ? 11 : 10 })}${last}</w:p>`;
    });
    return lines.join("");
  }

  async blob() {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${this.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}</Types>`,
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
    const rels = this.media
      .map(
        (m, i) =>
          `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`,
      )
      .join("");
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${this.header ? '<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ""}${rels}</Relationships>`,
    );
    zip.file("word/styles.xml", STYLES);
    if (this.header) {
      const field = (instr) =>
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      const small = '<w:rPr><w:color w:val="6B7280"/><w:sz w:val="17"/></w:rPr>';
      // logos in the header: company on the left, tool icon on the right
      const logoHeight = 34; // px on the page
      const headerImages = [];
      const logoRun = (logo, n) => {
        if (!logo) return "";
        const cy = logoHeight * EMU_PER_PX;
        const cx = Math.round((logo.widthPx / logo.heightPx) * cy);
        headerImages.push({ name: `logo${n}.png`, bytes: logo.bytes, rid: `rIdHdrImg${n}` });
        return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${900 + n}" name="Logo ${n}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${900 + n}" name="logo${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdHdrImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
      };
      const logos = this.header.logos;
      const left = logoRun(logos?.left, 1),
        right = logoRun(logos?.right, 2);
      const logoLine =
        left || right
          ? `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9026"/></w:tabs><w:spacing w:after="60"/></w:pPr>${left}<w:r><w:tab/></w:r>${right}</w:p>`
          : "";
      if (headerImages.length) {
        zip.file(
          "word/_rels/header1.xml.rels",
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${headerImages
            .map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`)
            .join("")}</Relationships>`,
        );
        for (const m of headerImages) zip.file(`word/media/${m.name}`, m.bytes);
      }
      zip.file(
        "word/header1.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${logoLine}<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="2F6F62"/></w:pBdr><w:jc w:val="right"/></w:pPr><w:r>${small}<w:t xml:space="preserve">${escapeXml(this.header.header)}</w:t></w:r></w:p></w:hdr>`,
      );
      zip.file(
        "word/footer1.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="6" w:space="4" w:color="C9D8D2"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="9026"/></w:tabs></w:pPr><w:r>${small}<w:t xml:space="preserve">${escapeXml(this.header.footer)}</w:t></w:r><w:r>${small}<w:tab/><w:t xml:space="preserve">Page </w:t></w:r>${field("PAGE")}<w:r>${small}<w:t xml:space="preserve"> of </w:t></w:r>${field("NUMPAGES")}</w:p></w:ftr>`,
      );
    }
    zip.file(
      "word/settings.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/></w:settings>`,
    );
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${this.body
        .map((x) => (x === "@@TOC@@" ? this.tocXml() : x))
        .join(
        "",
      )}<w:sectPr>${this.header ? '<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>' : ""}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1440" w:bottom="1134" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>${this.header ? "<w:titlePg/>" : ""}</w:sectPr></w:body></w:document>`,
    );
    for (const m of this.media) zip.file(`word/media/${m.name}`, m.bytes);
    return zip.generateAsync({
      type: "blob",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      compression: "DEFLATE",
    });
  }
}
