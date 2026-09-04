import { getLifeOsStorageProvider } from "./lifeos/container.js";
import { driveUrl } from "../lib/crypto.js";

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function minimalPdf(lines: string[]): Uint8Array {
  const content = lines
    .map((line, i) => `BT /F1 11 Tf 48 ${750 - i * 16} Td (${escapePdfText(line)}) Tj ET`)
    .join("\n");
  const stream = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj ${stream} endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  ];
  let offset = 9;
  const offsets = [0];
  let body = "%PDF-1.4\n";
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += `${obj}\n`;
    offset = Buffer.byteLength(body);
  }
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer);
}

export async function storeInvoicePdf(opts: {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  buyerName: string;
  currency: string;
  totalMinor: number;
  status: string;
}) {
  const pdf = minimalPdf([
    `ECommerceOS Invoice ${opts.orderNumber}`,
    `Order: ${opts.orderId}`,
    `Buyer: ${opts.buyerName}`,
    `Status: ${opts.status}`,
    `Total: ${opts.currency} ${(opts.totalMinor / 100).toFixed(2)}`,
    `Generated: ${new Date().toISOString()}`,
  ]);
  const key = `invoices/${opts.orderId}.pdf`;
  const stored = await getLifeOsStorageProvider().put({
    namespace: opts.tenantId,
    key,
    body: pdf,
    contentType: "application/pdf",
  });
  return {
    key: stored.key,
    url: stored.url ?? driveUrl(stored.namespace, stored.key),
  };
}
