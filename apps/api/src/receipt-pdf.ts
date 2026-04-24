/**
 * Invoice receipt PDF generator (TASK-IP-07).
 *
 * Uses `@react-pdf/renderer`'s Node API (`renderToBuffer`) to turn
 * a React.createElement tree into a `Buffer`. We deliberately do
 * NOT use TSX here so apps/api's server-only tsconfig stays
 * simple — there is exactly one PDF layout and a single helper
 * that builds it, no shared components to pull in.
 *
 * The caller passes a `ReceiptInput` shape with the values a
 * paying customer cares about; nothing sensitive (full stripe
 * ids, application fees, etc.) lands in the PDF.
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

export interface ReceiptLine {
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

export interface ReceiptInput {
  franchiseeName: string;
  customerName: string;
  customerEmail: string | null;
  invoiceNumber: string;
  status: string;
  issuedAt: Date;
  lines: ReceiptLine[];
  subtotal: string;
  taxAmount: string;
  total: string;
  paidAt: Date | null;
  notes: string | null;
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
  colRight: { flexGrow: 0, width: 80, textAlign: 'right' },
  totals: { marginTop: 16, alignSelf: 'flex-end', width: 200 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  totalLabel: { color: '#555' },
  total: { fontWeight: 700, fontSize: 12 },
  status: { marginTop: 8, fontSize: 9, color: '#16a34a' },
  notes: { marginTop: 24, fontSize: 9, color: '#555' },
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

function usd(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return `$${v}`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function buildDocument(input: ReceiptInput) {
  const lineRows = input.lines.map((l, idx) =>
    h(
      View,
      { key: idx, style: styles.row },
      h(Text, { style: styles.col }, `${l.name} — ${l.sku}`),
      h(Text, { style: styles.colRight }, `${l.quantity} × ${usd(l.unitPrice)}`),
      h(Text, { style: styles.colRight }, usd(l.lineTotal)),
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
          h(Text, { style: styles.brand }, input.franchiseeName),
          h(Text, { style: styles.metaRow }, 'Service.AI — Powered by Stripe'),
        ),
        h(
          View,
          { style: styles.meta },
          h(Text, { style: styles.metaRow }, `Invoice ${input.invoiceNumber}`),
          h(
            Text,
            { style: styles.metaRow },
            `Issued ${input.issuedAt.toDateString()}`,
          ),
          input.paidAt
            ? h(
                Text,
                { style: styles.status },
                `Paid ${input.paidAt.toDateString()}`,
              )
            : null,
        ),
      ),
      h(
        View,
        null,
        h(Text, { style: styles.sectionTitle }, 'Billed to'),
        h(Text, null, input.customerName),
        input.customerEmail
          ? h(Text, { style: styles.metaRow }, input.customerEmail)
          : null,
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
          h(Text, null, usd(input.subtotal)),
        ),
        h(
          View,
          { style: styles.totalRow },
          h(Text, { style: styles.totalLabel }, 'Tax'),
          h(Text, null, usd(input.taxAmount)),
        ),
        h(
          View,
          { style: styles.totalRow },
          h(Text, { style: styles.total }, 'Total'),
          h(Text, { style: styles.total }, usd(input.total)),
        ),
      ),
      input.notes
        ? h(Text, { style: styles.notes }, `Notes: ${input.notes}`)
        : null,
    ),
  );
}

export async function renderReceiptPdf(input: ReceiptInput): Promise<Buffer> {
  const doc = buildDocument(input);
  // react-pdf expects a DocumentElement; React.createElement on Document
  // satisfies that at runtime even if the nominal type isn't exported.
  const bytes = await renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
  return bytes;
}
