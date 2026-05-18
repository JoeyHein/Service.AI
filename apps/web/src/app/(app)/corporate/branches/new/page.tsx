import { NewBranchWizard } from './NewBranchWizard';

export default function NewBranchPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">New branch</h1>
      <p className="mt-1 text-sm text-slate-500">
        Three steps: identity, phone, manager.
      </p>
      <NewBranchWizard />
    </section>
  );
}
