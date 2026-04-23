import { Suspense } from 'react';
import { SignUpForm } from './SignUpForm';

export default function SignUpPage() {
  return (
    <Suspense fallback={null}>
      <SignUpForm />
    </Suspense>
  );
}
