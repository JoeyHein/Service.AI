import { CompPlanForm } from '../CompPlanForm';

export default function NewCompPlanPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">New comp plan</h1>
      <p className="mt-1 text-sm text-slate-500">
        Paste a commission_rules JSON array; field-level errors land
        inline.
      </p>
      <CompPlanForm mode="create" />
    </section>
  );
}
