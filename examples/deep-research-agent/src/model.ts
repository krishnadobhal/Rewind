/**
 * A chat model that answers from a script instead of a provider.
 *
 * The reference workload has to run for a stranger with no API key, and AGENTS.md §8
 * forbids benchmarking against a live provider — numbers have to be reproducible. This
 * is a real `BaseChatModel`, so LangGraph, `bindTools` and the callback plumbing all
 * behave exactly as they would with Anthropic behind them.
 *
 * ponytail: swap for `ChatAnthropic` when you want a genuine recording; nothing else
 * in the graph changes.
 */
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { toJsonSchema } from '@langchain/core/utils/json_schema';

export type ScriptedChatModelFields = BaseChatModelParams & {
  /** Returned in order, one per call. */
  responses: AIMessage[];
  model?: string;
};

export class ScriptedChatModel extends BaseChatModel {
  responses: AIMessage[];
  /** Part of the request identity, so it must look like a real id. */
  model: string;
  #tools: StructuredToolInterface[] = [];
  #calls = 0; // advances per call, unlike the stock fakes

  constructor(fields: ScriptedChatModelFields) {
    super(fields);
    this.responses = fields.responses;
    this.model = fields.model ?? 'scripted-research-1';
  }

  _llmType(): string {
    return 'scripted';
  }

  _combineLLMOutput(): Record<string, unknown> {
    return {};
  }

  /** Converts tools to JSON Schema and binds them, as real models do. */
  override bindTools(tools: StructuredToolInterface[]) {
    this.#tools = tools;
    // JSON Schema, not the raw Zod object — this is what a provider would receive,
    // and it is what ends up in the request hash.
    const dicts = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: toJsonSchema(t.schema) },
    }));
    return this.withConfig({ tools: dicts });
  }

  /** Returns the next scripted message, ignoring the prompt. */
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.responses[this.#calls++] ?? new AIMessage('(script exhausted)');
    void messages; // a real model would read these; the script does not
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }], llmOutput: {} };
  }
}
