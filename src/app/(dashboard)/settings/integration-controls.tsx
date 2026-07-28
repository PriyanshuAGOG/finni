'use client';

import { useActionState, useState } from 'react';
import { createApiClientAction, type CreateApiClientState } from '../../actions/integrations';

const initialState: CreateApiClientState = { error: null, result: null };

// The scopes a Custom GPT prototype typically needs -- everything short
// of admin/audit access. Matches Path B in docs/gpt-setup-guide.md.
const DEFAULT_SCOPES = [
  'knowledge.read',
  'source.read',
  'source.write',
  'collection.read',
  'collection.write',
  'taxonomy.read',
  'taxonomy.write',
  'claim.read',
  'claim.write',
  'annotation.read',
  'annotation.write',
  'research.run',
  'brief.read',
  'brief.write',
  'content.generate',
];

const ALL_SCOPES = [
  'profile.read',
  ...DEFAULT_SCOPES,
  'source.review',
  'claim.review',
  'audit.read',
  'admin.integrations',
];

export function CreateApiClientForm() {
  const [state, formAction, pending] = useActionState(createApiClientAction, initialState);
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  if (state.result) {
    return (
      <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-900">
          Save this key now -- it will not be shown again.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1.5 text-xs">
            {state.result.api_key}
          </code>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            onClick={() => {
              void navigator.clipboard.writeText(state.result!.api_key);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="space-y-1 text-sm text-slate-700">
          <p className="font-semibold">Next, in the ChatGPT GPT editor:</p>
          <ol className="ml-4 list-decimal space-y-0.5">
            <li>Configure &rarr; Actions &rarr; Create new action &rarr; Import from URL:</li>
          </ol>
          <code className="ml-4 block overflow-x-auto rounded bg-white px-2 py-1 text-xs">
            {origin}/gpt-actions.yaml
          </code>
          <ol start={2} className="ml-4 list-decimal space-y-0.5">
            <li>Authentication &rarr; API Key &rarr; Auth Type: Bearer &rarr; paste the key above.</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="client_name">Name</label>
        <input
          id="client_name"
          name="name"
          type="text"
          defaultValue="Custom GPT"
          className="input"
        />
      </div>

      <fieldset>
        <legend className="label mb-1">Scopes</legend>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          {ALL_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1.5 text-slate-700">
              <input
                type="checkbox"
                name="scopes"
                value={scope}
                defaultChecked={DEFAULT_SCOPES.includes(scope)}
              />
              {scope}
            </label>
          ))}
        </div>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? 'Creating…' : 'Create API key'}
      </button>
    </form>
  );
}
