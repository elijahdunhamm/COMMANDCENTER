import type { Intent, RouterKind } from "./types";

/**
 * Model adapter: the single place the app talks to an LLM.
 *
 * - Provider is env-configurable only (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL),
 *   OpenAI-compatible chat-completions. A model name is NEVER hard-coded.
 * - Without a key (or on any LLM error/timeout) a deterministic fallback
 *   router classifies the command with keyword rules, so the pipeline keeps
 *   working with zero credentials. The caller is always told which router ran.
 */

export interface Classification {
  intent: Intent;
  /** Short subject for the downstream agent, e.g. "Eiffel Tower". */
  subject: string;
  router: RouterKind;
  /** Model name when router=llm; rule summary when router=fallback. */
  reasoning: string;
  model: string | null;
}

export function llmConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

const SYSTEM_PROMPT = `You classify a user command for an AI agent dashboard.
Reply with ONLY a JSON object, no markdown, no prose, exactly this shape:
{"intent":"research"|"coding"|"opportunity"|"dealfinder","subject":"<short noun phrase the task is about>"}
Intent meanings:
- research: look up facts, summarize a topic, geocode a place (e.g. "research the Eiffel Tower")
- coding: write, fix, review, or deploy code
- opportunity: business or market opportunities, leads, niches
- dealfinder: find and compare local businesses or prices (e.g. "find a barber under $40")`;

/** Calls an OpenAI-compatible /chat/completions endpoint. Never throws. */
async function chatJson(
  cfg: { baseUrl: string; apiKey: string; model: string },
  userMessage: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const VALID_INTENTS: Intent[] = ["research", "coding", "opportunity", "dealfinder"];

/* ------------------------------------------------ deterministic fallback */

const RULES: { intent: Intent; label: string; re: RegExp }[] = [
  {
    intent: "dealfinder",
    label: "price/comparison or local-business phrasing",
    re: /\b(find me|cheapest|cheaper|under \$?\d|within \d+ ?(mi|miles|km)|near me|compare (prices|options)|barber|salon|dentist|plumber|mechanic|restaurant|deal)\b/i,
  },
  {
    intent: "coding",
    label: "software work phrasing",
    re: /\b(code|coding|build (a|an|the)|fix|bug|deploy|refactor|typescript|javascript|python|script|api endpoint|test suite|compile)\b/i,
  },
  {
    intent: "opportunity",
    label: "business-opportunity phrasing",
    re: /\b(opportunit|lead|prospect|market gap|niche|competitor|monetiz|revenue|invest)\w*\b/i,
  },
  {
    intent: "research",
    label: "fact-finding or geocoding phrasing",
    re: /\b(research|look up|lookup|who|what|where|when|history of|summar(y|ize)|explain|tell me about|info( of| on|rmation)?|geocode|coordinates|location of)\b/i,
  },
];

/** Strips filler and leading verb phrases to pull out a subject noun phrase. */
function extractSubject(command: string): string {
  let s = command.trim().replace(/^["'`]+|["'`]+$/g, "");
  // Cut at the first connector so "research X and tell me where it is" keeps X.
  s = s.split(/\b(?:and then|then|and also|also|and)\b|[,;?!]/i)[0] ?? s;
  s = s.replace(
    /^(please\s+)?(can you\s+|could you\s+)?(research|find( me)?|look ?up|lookup|tell me about|get me|give me|show me|summarize|summarise|explain|what is|what's|who is|who's|where is|info on|information on|find info (on|about)|search for)\s+/i,
    "",
  );
  s = s.replace(/^(the|a|an)\s+/i, "");
  s = s.replace(/\s+/g, " ").trim();
  return s || command.trim();
}

export function classifyWithFallback(command: string): Classification {
  for (const rule of RULES) {
    const m = command.match(rule.re);
    if (m) {
      return {
        intent: rule.intent,
        subject: extractSubject(command),
        router: "fallback",
        reasoning: `matched "${m[0]}" (rule: ${rule.label})`,
        model: null,
      };
    }
  }
  return {
    intent: "research",
    subject: extractSubject(command),
    router: "fallback",
    reasoning: "no keyword rule matched; defaulted to research (the registered functional capability)",
    model: null,
  };
}

/* --------------------------------------------------------------- top level */

export async function classifyCommand(command: string): Promise<Classification> {
  const cfg = llmConfig();
  if (!cfg) return classifyWithFallback(command);

  const parsed = await chatJson(cfg, command.slice(0, 2000), 12000);
  const intent = typeof parsed?.intent === "string" ? (parsed.intent as Intent) : null;
  if (intent && VALID_INTENTS.includes(intent)) {
    const subject =
      typeof parsed?.subject === "string" && parsed.subject.trim()
        ? parsed.subject.trim().slice(0, 200)
        : extractSubject(command);
    return {
      intent,
      subject,
      router: "llm",
      reasoning: `classified by model ${cfg.model}`,
      model: cfg.model,
    };
  }
  const fb = classifyWithFallback(command);
  return {
    ...fb,
    reasoning: `LLM router failed or returned an invalid intent; fell back to rules: ${fb.reasoning}`,
  };
}
