// Supabase Edge Function: POST { to, subject, text } with the signed-in user's token.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './handler.ts';

function publishableKey(): string {
  const keys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (keys) {
    try { return JSON.parse(keys).default; } catch { /* fall back to the legacy key */ }
  }
  return Deno.env.get('SUPABASE_ANON_KEY')!;
}

Deno.serve((req) => handle(req, {
  env: (name) => Deno.env.get(name),
  fetch,
  // Queries run as the caller, so row-level security decides what they may do.
  db: (authorization) => createClient(Deno.env.get('SUPABASE_URL')!, publishableKey(), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
}));
