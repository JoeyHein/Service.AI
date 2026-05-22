import { NewCustomerForm } from './NewCustomerForm';

export default function NewCustomerPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">New customer</h1>
      <p className="mt-1 text-sm text-slate-500">
        Start typing to auto-fill from Google Places, or just type the full
        address and it&apos;ll be saved as-is.
      </p>
      <div className="mt-6">
        <NewCustomerForm />
      </div>
    </section>
  );
}
