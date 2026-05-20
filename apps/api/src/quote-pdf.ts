/**
 * Customer quote PDF generator (CQA-04).
 *
 * Mirrors `receipt-pdf.ts`: `@react-pdf/renderer`'s `renderToBuffer` turns
 * a `React.createElement` tree into a `Buffer`, no TSX so apps/api's
 * server-only tsconfig stays simple. One layout, one builder.
 *
 * The input carries only what a homeowner should see — line descriptions,
 * selling prices, totals, the SQ ref, validity, and the deposit due.
 * Supplier cost, applied margin, and internal ids never reach this shape
 * (the caller is responsible for not passing them; the public route builds
 * the input from its field-leak-safe view).
 */

import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';

export interface QuotePdfLine {
  sku: string;
  description: string | null;
  quantity: string;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface QuotePdfInput {
  branchName: string;
  customerName: string;
  supplierQuoteRef: string | null;
  currencyCode: string;
  lines: QuotePdfLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  validUntil: Date | null;
  depositAmountCents: number | null;
}

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Helvetica', fontSize: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  brand: { fontSize: 18, fontWeight: 700 },
  meta: { textAlign: 'right' },
  metaRow: { fontSize: 9, color: '#555' },
  sectionTitle: { fontSize: 11, fontWeight: 700, marginTop: 12, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottomColor: '#e5e7eb', borderBottomWidth: 1, paddingVertical: 4 },
  col: { flexGrow: 1 },
  colRight: { flexGrow: 0, width: 90, textAlign: 'right' },
  totals: { marginTop: 16, alignSelf: 'flex-end', width: 220 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  totalLabel: { color: '#555' },
  total: { fontWeight: 700, fontSize: 12 },
  deposit: { marginTop: 8, fontSize: 10, color: '#1d4ed8', fontWeight: 700 },
  footer: { marginTop: 24, fontSize: 9, color: '#555' },
});

function h(
  tag: unknown,
  props: Record<string, unknown> | null = null,
  ...children: unknown[]
): React.ReactElement {
  return React.createElement(
    tag as Parameters<typeof React.createElement>[0],
    props,
    ...(children as React.ReactNode[]),
  );
}

function money(cents: number, currency: string): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: currency || 'CAD',
    maximumFractionDigits: 2,
  });
}

function buildDocument(input: QuotePdfInput) {
  const cur = input.currencyCode;
  const lineRows = input.lines.map((l, idx) =>
    h(
      View,
      { key: idx, style: styles.row },
      h(Text, { style: styles.col }, l.description ? `${l.description} — ${l.sku}` : l.sku),
      h(
        Text,
        { style: styles.colRight },
        `${l.quantity} × ${money(l.unitPriceCents, cur)}`,
      ),
      h(Text, { style: styles.colRight }, money(l.lineTotalCents, cur)),
    ),
  );
  return h(
    Document,
    null,
    h(
      Page,
      { size: 'LETTER', style: styles.page },
      h(
        View,
        { style: styles.header },
        h(
          View,
          null,
          h(Text, { style: styles.brand }, input.branchName),
          h(Text, { style: styles.metaRow }, 'Quote'),
        ),
        h(
          View,
          { style: styles.meta },
          input.supplierQuoteRef
            ? h(Text, { style: styles.metaRow }, `Quote ${input.supplierQuoteRef}`)
            : null,
          input.validUntil
            ? h(
                Text,
                { style: styles.metaRow },
                `Valid until ${input.validUntil.toDateString()}`,
              )
            : null,
        ),
      ),
      h(
        View,
        null,
        h(Text, { style: styles.sectionTitle }, 'Prepared for'),
        h(Text, null, input.customerName),
      ),
      h(Text, { style: styles.sectionTitle }, 'Items'),
      ...lineRows,
      h(
        View,
        { style: styles.totals },
        h(
          View,
          { style: styles.totalRow },
          h(Text, { style: styles.totalLabel }, 'Subtotal'),
          h(Text, null, money(input.subtotalCents, cur)),
        ),
        h(
          View,
          { style: styles.totalRow },
          h(Text, { style: styles.totalLabel }, 'Tax'),
          h(Text, null, money(input.taxCents, cur)),
        ),
        h(
          View,
          { style: styles.totalRow },
          h(Text, { style: styles.total }, 'Total'),
          h(Text, { style: styles.total }, money(input.totalCents, cur)),
        ),
        input.depositAmountCents !== null
          ? h(
              Text,
              { style: styles.deposit },
              `Deposit due to accept: ${money(input.depositAmountCents, cur)}`,
            )
          : null,
      ),
      h(
        Text,
        { style: styles.footer },
        'This quote is an estimate. Final pricing is confirmed on acceptance.',
      ),
    ),
  );
}

export async function renderQuotePdf(input: QuotePdfInput): Promise<Buffer> {
  const doc = buildDocument(input);
  const bytes = await renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
  return bytes;
}
