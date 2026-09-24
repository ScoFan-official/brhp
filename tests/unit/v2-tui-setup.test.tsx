/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from 'vitest';

import { createV2TuiSetup } from '../../src/v2/tui-setup.js';

describe('OpenCode v2 TUI setup', () => {
  it('registers the sidebar slot and refresh command, then disposes on cleanup', () => {
    const events: string[] = [];
    const setup = createV2TuiSetup({
      createOwner: () => ({
        async getRuntime() {
          events.push('getRuntime');
          return {
            async getActive() {
              return null;
            },
          } as never;
        },
        async dispose() {
          events.push('disposeRuntime');
        },
      }),
    });
    let refresh: (() => void) | undefined;
    const context = {
      location: {
        directory: '/repo',
        worktree: '/repo',
      },
      theme: {
        text: {
          base: '#fff',
          muted: '#aaa',
          danger: '#f00',
        },
      },
      ui: {
        toast: {
          show() {
            events.push('toast');
          },
        },
        slot() {
          events.push('registerSlot');
          return () => {
            events.push('unregisterSlot');
          };
        },
      },
      keymap: {
        layer(definition: () => { commands: Array<{ id: string; run(): void }> }) {
          const layer = definition();
          expect(layer.commands.map(command => command.id)).toEqual(['brhp.refresh']);
          refresh = layer.commands[0]?.run;
          events.push('registerCommand');
          return () => {
            events.push('unregisterCommand');
          };
        },
      },
    };

    const cleanup = setup(context);
    refresh?.();
    cleanup();

    expect(events).toEqual([
      'registerSlot',
      'registerCommand',
      'toast',
      'unregisterCommand',
      'unregisterSlot',
      'disposeRuntime',
    ]);
  });
});
