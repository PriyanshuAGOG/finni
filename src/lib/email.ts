import { getEnv } from './env';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/** Dev default: no network call, no account needed. Logs instead of sending. */
class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    console.log(
      `[email:console] to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
  }
}

class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Resend returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
  }
}

let cachedProvider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cachedProvider) return cachedProvider;
  const env = getEnv();

  if (env.EMAIL_PROVIDER === 'resend') {
    // getEnv() already refuses to validate EMAIL_PROVIDER=resend without
    // RESEND_API_KEY set; the check stays for TypeScript, not because it
    // can fail here.
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend.');
    cachedProvider = new ResendEmailProvider(env.RESEND_API_KEY, env.EMAIL_FROM);
    return cachedProvider;
  }

  cachedProvider = new ConsoleEmailProvider();
  return cachedProvider;
}

/** Test helper: forget the cached provider so a changed env is re-read. */
export function resetEmailProviderCache(): void {
  cachedProvider = null;
}
