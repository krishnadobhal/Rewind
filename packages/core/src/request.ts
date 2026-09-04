/**
 * The shape of a boundary crossing as the SDK observes it, before canonicalization.
 * `hash.ts` decides which of these fields are identity and which are volatile;
 * docs/HASHING.md §2 is the authority on that split.
 */

export type Message = {
  role: string;
  content: unknown;
  [k: string]: unknown;
};

export type ModelRequest = {
  kind: 'model';
  provider: string;
  model_id: string;
  messages: Message[];
  /** Hashed separately by the caller so a prompt change is legible in a diff. */
  system_prompt_sha?: string;
  tool_schemas?: { name: string; [k: string]: unknown }[];
  response_format?: unknown;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  seed?: number;
  max_tokens?: number;
  tool_choice?: unknown;
};

export type ToolRequest = { kind: 'tool'; tool_name: string; args: unknown };

/** Clock and RNG hash their logical counter, never the observed value (B3, B4). */
export type ShimRequest = { kind: 'clock' | 'rng'; counter: number };

export type RewindRequest = ModelRequest | ToolRequest | ShimRequest;
