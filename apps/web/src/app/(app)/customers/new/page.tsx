import { NewCustomerForm } from './NewCustomerForm';

export default function NewCustomerPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">New customer</h1>
      <p className="mt-1 text-sm text-slate-500">
        Type an address to auto-fill from Google Places.
      </p>
      <div className="mt-6">
        <NewCustomerForm />
      </div>
    </section>
  );
}
