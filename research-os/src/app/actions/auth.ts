'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getEnv } from '../../lib/env';
import { signIn, signOut } from '../../services/auth';

export interface SignInState {
  error: string | null;
}

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '/');

  if (!email || !password) {
    return { error: 'Enter your email and password.' };
  }

  const headerList = await headers();
  const env = getEnv();

  try {
    const { token, expiresAt } = await signIn(email, password, {
      ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: headerList.get('user-agent') ?? undefined,
    });

    const cookieStore = await cookies();
    cookieStore.set(env.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  } catch {
    // The service already gives a generic, non-enumerating message; keep
    // the UI message equally generic.
    return { error: 'Email or password is incorrect.' };
  }

  redirect(next && next.startsWith('/') ? next : '/');
}

export async function signOutAction(): Promise<void> {
  const env = getEnv();
  const cookieStore = await cookies();
  const token = cookieStore.get(env.SESSION_COOKIE_NAME)?.value;
  if (token) await signOut(token);
  cookieStore.delete(env.SESSION_COOKIE_NAME);
  redirect('/sign-in');
}
