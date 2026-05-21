import Link from 'next/link';
import { NewItemForm } from './NewItemForm';

export default function NewInventoryItemPage() {
  return (
    <section className="max-w-xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">New stocked item</h1>
        <Link href="/inventory" className="text-sm text-slate-600 hover:underline">
          ← Inventory
        </Link>
      </div>
      <NewItemForm />
    </section>
  );
}
