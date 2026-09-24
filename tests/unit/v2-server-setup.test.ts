import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BRHP_TOOL_IDS } from '../../src/domain/planning/planner-tool.js';
import {
  setup,
  type OpenCodeV2ServerContext,
  type OpenCodeV2SystemEvent,
} from '../../src/v2/server-setup.js';

describe('OpenCode v2 server setup', () => {
  it('registers planner tools, the /brhp command, and planning context hooks', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'brhp-v2-server-'));
    const projectDirectory = path.join(tempRoot, 'project');
    const instructions = path.join(projectDirectory, '.opencode', 'brhp', 'instructions');
    const originalConfigDirectory = process.env.OPENCODE_CONFIG_DIR;

    await mkdir(instructions, { recursive: true });
    await writeFile(path.join(instructions, 'planning.md'), '# Planning\n\nKeep the frontier explicit.');
    process.env.OPENCODE_CONFIG_DIR = tempRoot;

    const tools: Array<{ name: string; description: string; input: Record<string, unknown> }> = [];
    const commands: Array<{ name: string; description?: string; execute: (input: unknown) => Promise<void> }> = [];
    const hooks = new Map<string, (event: OpenCodeV2SystemEvent) => Promise<void> | void>();
    const prompts: string[] = [];

    const ctx = {
      location: {
        directory: projectDirectory,
        project: {
          id: 'project',
          directory: projectDirectory,
        },
      },
      session: {
        async get() {
          return { location: { directory: projectDirectory } };
        },
        async prompt(input: { text: string }) {
          prompts.push(input.text);
        },
        async hook(kind: string, callback: (event: OpenCodeV2SystemEvent) => Promise<void> | void) {
          hooks.set(kind, callback);
        },
      },
      tool: {
        async transform(callback: (editor: { add(tool: (typeof tools)[number]): void }) => void) {
          callback({
            add(tool) {
              tools.push(tool);
            },
          });
        },
      },
      command: {
        async transform(
          callback: (editor: { add(command: (typeof commands)[number]): void }) => void
        ) {
          callback({
            add(command) {
              commands.push(command);
            },
          });
        },
      },
    } satisfies OpenCodeV2ServerContext;

    try {
      await setup(ctx);

      expect(tools.map(tool => tool.name)).toEqual([
        BRHP_TOOL_IDS.getActivePlan,
        BRHP_TOOL_IDS.decomposeNode,
        BRHP_TOOL_IDS.validateActiveScope,
        BRHP_TOOL_IDS.completeLeaf,
      ]);
      expect(tools[0]?.input).toMatchObject({ type: 'object', additionalProperties: false });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        name: 'brhp',
        description: expect.stringContaining('BRHP'),
      });
      expect(hooks.has('context')).toBe(true);
      expect(hooks.has('compaction')).toBe(true);

      await commands[0]?.execute({
        sessionID: 'session-1',
        prompt: { text: '' },
        delivery: 'steer',
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('# BRHP Plugin');
      expect(prompts[0]).toContain('[project] Planning (planning.md)');

      const event: OpenCodeV2SystemEvent = {
        sessionID: 'session-1',
        system: [],
      };
      await hooks.get('context')?.(event);
      expect(event.system.map(part => part.text).join('\n')).toContain('# BRHP Instructions');
    } finally {
      if (originalConfigDirectory === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = originalConfigDirectory;
      }

      await rm(tempRoot, { recursive: true, force: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') {
          throw error;
        }
      });
    }
  });
});
