// SPDX-License-Identifier: AGPL-3.0-only
// ChatGPT through a person's own subscription (record 23): Kvasir's own
// backend, never added, stored or removed. It streams through pi-ai's OpenAI
// Codex adapter with the token of the person streaming, or of the system
// where nobody signs in, and the policy sends it nobody who has no
// subscription signed in.

import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Backend, Backends } from "./backends.js";
import type { BackendConfig } from "./config.js";
import { CHATGPT, type SubscriptionAuth, type Subscriptions } from "./subscriptions.js";

const provider = openaiCodexProvider();

/** The models ChatGPT serves a subscription, as pi-ai lists them. */
export function chatgptModels(): { id: string; name: string; contextWindow: number }[] {
  return provider.getModels().map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
}

/** The sign-in, the refresh and the request auth pi-ai does for OpenAI Codex. */
export function chatgptAuth(): SubscriptionAuth {
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error("pi-ai offers no ChatGPT sign-in");
  return oauth;
}

/** Kvasir's ChatGPT backend, served beside the models an admin added; a stream's subject names whose subscription it uses. */
export function chatgptBackend(backends: Backends, subscriptions: Subscriptions): Backend {
  const natives = new Map(provider.getModels().map((m) => [m.id, m]));
  const config: BackendConfig = {
    id: CHATGPT,
    kind: "openai-codex-responses",
    baseUrl: provider.baseUrl ?? "https://chatgpt.com/backend-api",
    locality: "remote",
    concurrency: 8,
    builtin: true,
    // there is no subscription to warm it with: a stream reaches it only for a person signed in
    warmup: false,
    models: provider.getModels().map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: [...m.input],
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      // a subscription is paid for by its person, so a stream costs the install nothing
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  };
  const backend = backends.make(config);
  backend.native = (entry) => natives.get(entry.id);
  backend.credential = (subject) => (subject ? subscriptions.token(subject) : null);
  return backend;
}
