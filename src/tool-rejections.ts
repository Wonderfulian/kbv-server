/**
 * Makes tool calls that the MCP SDK rejects before our handler runs visible.
 *
 * When a tools/call carries arguments that do not match the tool's input
 * schema (a missing field, a number where a string is expected), the SDK
 * answers with an isError result and never calls the handler — so no
 * tool_call event is written. Before this file existed, a first-time user who
 * got a parameter wrong was indistinguishable from nobody at all
 * (2026-10-26: "zero calls" could not be confirmed for that reason).
 *
 * What is recorded: the tool name (only if it is one of ours), the top-level
 * field name (only if it is one of the tool's fields) and the kind of failure
 * (zod issue code, plus the expected type). Never a value — the same rule as
 * every other log line here: no query contents.
 *
 * The SDK keeps its request handlers and tool registry private, so this
 * reaches into two private fields. test/tool-rejections.test.ts pins the
 * behaviour against the installed SDK; if an upgrade moves them, the wrapper
 * stays inert (calls are still answered by the SDK) and that test fails.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ToolRejection {
  /** Our tool name, or "unknown_tool" for a name we do not serve. */
  tool: string;
  stage: 'unknown_tool' | 'schema';
  /** One entry per failing field; empty for unknown_tool. */
  issues: { field: string; code: string; expected?: string }[];
}

type Parseable = { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; code: string; expected?: unknown }[] } } };
type Handler = (request: { params?: { name?: unknown; arguments?: unknown } }, extra: unknown) => Promise<unknown>;

export function observeToolRejections(server: McpServer, report: (r: ToolRejection) => void): boolean {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers;
  const registry = (server as unknown as { _registeredTools?: Record<string, { inputSchema?: Parseable }> })._registeredTools;
  const original = handlers?.get('tools/call');
  if (!handlers || !registry || !original) return false;

  handlers.set('tools/call', async (request, extra) => {
    try {
      const name = request.params?.name;
      const tool = typeof name === 'string' && Object.hasOwn(registry, name) ? registry[name] : undefined;
      if (!tool) {
        report({ tool: 'unknown_tool', stage: 'unknown_tool', issues: [] });
      } else if (tool.inputSchema) {
        const parsed = tool.inputSchema.safeParse(request.params?.arguments ?? {});
        if (!parsed.success) {
          const fields = fieldNames(tool.inputSchema);
          const issues = (parsed.error?.issues ?? []).map((i) => {
            const top = i.path[0];
            const field = top === undefined ? '(arguments)' : typeof top === 'string' && fields.has(top) ? top : '(other)';
            return {
              field: i.path.length > 1 && field !== '(other)' ? `${field}[]` : field,
              code: i.code,
              ...(typeof i.expected === 'string' ? { expected: i.expected } : {}),
            };
          });
          report({ tool: name as string, stage: 'schema', issues });
        }
      }
    } catch {
      // Observation must never change the answer.
    }
    return original(request, extra);
  });
  return true;
}

function fieldNames(schema: Parseable): Set<string> {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return new Set(shape ? Object.keys(shape) : []);
}
