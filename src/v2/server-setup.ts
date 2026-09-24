import type { PluginInput } from '@opencode-ai/plugin';

import { createServerPluginHooks } from '../composition/create-server-plugin.js';
import { BRHP_TOOL_IDS } from '../domain/planning/planner-tool.js';
import {
  BRHP_COMMAND_DESCRIPTION,
  BRHP_COMMAND_NAME,
} from '../domain/slash-command/brhp-command.js';

type JsonSchema = Record<string, unknown>;

export interface OpenCodeV2ToolContext {
  readonly sessionID: string;
  readonly messageID: string;
  readonly agent: string;
  readonly id: string;
  readonly signal: AbortSignal;
  progress(update: { title?: string; metadata?: Record<string, unknown> }): Promise<void> | void;
}

export interface OpenCodeV2SystemEvent {
  readonly sessionID: string;
  system: Array<{ type?: string; text: string }>;
}

export interface OpenCodeV2ServerContext {
  readonly location: {
    readonly directory: string;
    readonly project?: {
      readonly id?: string;
      readonly directory?: string;
      readonly canonical?: string;
    };
  };
  readonly session: {
    get(input: { sessionID: string }): Promise<{
      location?: { directory?: string };
    }>;
    prompt(input: {
      sessionID: string;
      text: string;
      delivery?: 'steer' | 'queue';
    }): Promise<unknown>;
    hook(
      kind: 'context' | 'compaction',
      callback: (event: OpenCodeV2SystemEvent) => Promise<void> | void
    ): Promise<unknown>;
  };
  readonly tool: {
    transform(
      callback: (editor: {
        add(tool: {
          name: string;
          description: string;
          input: JsonSchema;
          execute(
            input: unknown,
            context: OpenCodeV2ToolContext
          ): Promise<{ content: string }>;
        }): void;
      }) => void
    ): Promise<unknown>;
  };
  readonly command: {
    transform(
      callback: (editor: {
        add(command: {
          name: string;
          description?: string;
          execute(input: {
            sessionID: string;
            prompt: { text?: string };
            delivery?: 'steer' | 'queue';
          }): Promise<void>;
        }): void;
      }) => void
    ): Promise<unknown>;
  };
}

const stringSchema = { type: 'string', minLength: 1 } as const;

export const BRHP_V2_TOOL_SCHEMAS: Record<string, JsonSchema> = {
  [BRHP_TOOL_IDS.getActivePlan]: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  [BRHP_TOOL_IDS.decomposeNode]: {
    type: 'object',
    properties: {
      nodeId: stringSchema,
      children: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            title: stringSchema,
            problemStatement: stringSchema,
            category: {
              type: 'string',
              enum: ['dependent', 'isolated', 'parallelizable', 'cross-cutting'],
            },
            rationale: stringSchema,
          },
          required: ['title', 'problemStatement', 'category'],
          additionalProperties: false,
        },
      },
    },
    required: ['nodeId', 'children'],
    additionalProperties: false,
  },
  [BRHP_TOOL_IDS.validateActiveScope]: {
    type: 'object',
    properties: {
      clauses: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: stringSchema,
            kind: {
              type: 'string',
              enum: ['schema', 'structure', 'dependency', 'conflict', 'coverage'],
            },
            blocking: { type: 'boolean' },
            description: stringSchema,
            status: {
              type: 'string',
              enum: ['pending', 'passed', 'failed', 'skipped'],
            },
            message: stringSchema,
          },
          required: ['kind', 'blocking', 'description', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['clauses'],
    additionalProperties: false,
  },
  [BRHP_TOOL_IDS.completeLeaf]: {
    type: 'object',
    properties: {
      nodeId: stringSchema,
      completionSummary: stringSchema,
    },
    required: ['nodeId', 'completionSummary'],
    additionalProperties: false,
  },
};

export async function setup(ctx: OpenCodeV2ServerContext): Promise<void> {
  const legacyInput = createLegacyPluginInput(ctx);
  const hooks = await createServerPluginHooks(legacyInput);

  await ctx.tool.transform(editor => {
    for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
      const input = BRHP_V2_TOOL_SCHEMAS[name] ?? {
        type: 'object',
        additionalProperties: true,
      };

      editor.add({
        name,
        description: definition.description,
        input,
        async execute(toolInput, context) {
          const directory = await resolveSessionDirectory(ctx, context.sessionID);
          const result = await definition.execute(toolInput as never, {
            sessionID: context.sessionID,
            messageID: context.messageID,
            agent: context.agent,
            directory,
            worktree: directory,
            abort: context.signal,
            metadata(update: { title?: string; metadata?: Record<string, unknown> }) {
              void context.progress({
                ...(update.title ? { title: update.title } : {}),
                ...(update.metadata ? { metadata: update.metadata } : {}),
              });
            },
            ask() {
              throw new Error('BRHP tools do not request extra permissions');
            },
          } as never);

          return {
            content: typeof result === 'string' ? result : result.output,
          };
        },
      });
    }
  });

  await ctx.command.transform(editor => {
    editor.add({
      name: BRHP_COMMAND_NAME,
      description: BRHP_COMMAND_DESCRIPTION,
      async execute(invocation) {
        const output = {
          parts: [] as Array<{ type: string; text: string }>,
        };

        await hooks['command.execute.before']?.(
          {
            command: BRHP_COMMAND_NAME,
            sessionID: invocation.sessionID,
            arguments: invocation.prompt.text ?? '',
          },
          output as never
        );

        const text = output.parts.map(part => part.text).join('\n').trim();
        if (!text) {
          return;
        }

        await ctx.session.prompt({
          sessionID: invocation.sessionID,
          text,
          delivery: invocation.delivery ?? 'steer',
        });
      },
    });
  });

  const injectPlanningContext = async (event: OpenCodeV2SystemEvent) => {
    const system: string[] = [];
    await hooks['experimental.chat.system.transform']?.(
      {
        sessionID: event.sessionID,
        model: { providerID: 'brhp', modelID: 'planner' },
      } as never,
      { system }
    );

    for (const text of system) {
      if (text.trim().length > 0) {
        event.system.push({ type: 'text', text });
      }
    }
  };

  await ctx.session.hook('context', injectPlanningContext);
  await ctx.session.hook('compaction', injectPlanningContext);
}

function createLegacyPluginInput(ctx: OpenCodeV2ServerContext): PluginInput {
  const directory = ctx.location.project?.directory ?? ctx.location.directory;
  const projectId = ctx.location.project?.id ?? 'brhp';

  return {
    directory: ctx.location.directory,
    worktree: directory,
    project: {
      id: projectId,
      worktree: directory,
      name: projectId,
    },
    client: {
      session: {
        async get(options: { path: { id: string } }) {
          const session = await ctx.session.get({ sessionID: options.path.id });
          return {
            data: {
              directory: session.location?.directory ?? directory,
            },
          };
        },
      },
      project: {
        async current() {
          return {
            data: {
              worktree: directory,
            },
          };
        },
      },
    },
  } as unknown as PluginInput;
}

async function resolveSessionDirectory(
  ctx: OpenCodeV2ServerContext,
  sessionID: string
): Promise<string> {
  try {
    const session = await ctx.session.get({ sessionID });
    if (session.location?.directory) {
      return session.location.directory;
    }
  } catch {
    // Fall back to the plugin location when the session lookup is unavailable.
  }

  return ctx.location.project?.directory ?? ctx.location.directory;
}
