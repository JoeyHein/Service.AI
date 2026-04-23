import type { ReactNode } from 'react';

/**
 * Shared layout for unauthenticated auth routes (signin, signup, verify,
 * accept-invite). Centers content in a card, keeps everything tight on
 * mobile, and matches the app-shell palette.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Service.AI</h1>
          <p className="mt-1 text-sm text-slate-500">
            AI-native field service platform
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-6">
          {children}
        </div>
      </div>
    </main>
  );
}
