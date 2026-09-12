import assert from 'node:assert/strict';
import { test } from 'node:test';
import PDFDocument from 'pdfkit';

async function makePdf(): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  doc.text('Filtra.AI PDF smoke test');
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

test('PDF gerado começa com header PDF válido', async () => {
  const pdf = await makePdf();
  assert.ok(pdf.length > 100);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
});
