import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionContext } from '../lib/session';
import { signOutAction } from '../actions/auth';

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/inbox', label: 'Research Inbox' },
  { href: '/library', label: 'Library' },
  { href: '/search', label: 'Search' },
  { href: '/collections', label: 'Collections' },
  { href: '/categories', label: 'Categories' },
  { href: '/claims', label: 'Claims' },
  { href: '/briefs', label: 'Briefs' },
  { href: '/content', label: 'Content Studio' },
  { href: '/activity', label: 'Activity' },
  { href: '/settings', label: 'Settings' },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getSessionContext();
  if (!ctx) redirect('/sign-in');

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:block">
        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-brand-600 text-xs font-semibold text-white">
            NB
          </div>
          <span className="text-sm font-semibold text-slate-900">Research OS</span>
        </div>
        <nav className="space-y-0.5 p-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4">
          <div className="text-sm text-slate-500">
            Signed in as <span className="font-medium text-slate-900">{ctx.userName}</span>
          </div>
          <form action={signOutAction}>
            <button type="submit" className="btn btn-secondary">
              Sign out
            </button>
          </form>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
