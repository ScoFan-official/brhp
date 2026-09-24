/** @jsxImportSource @opentui/solid */
import type { TuiTheme } from '@opencode-ai/plugin/tui';

import { createPlannerRuntimeForWorktree } from '../composition/create-planner-runtime.js';
import { createPlannerRuntimeOwner } from '../composition/create-planner-runtime-owner.js';
import type { CreateTuiPluginOptions } from '../composition/create-tui-plugin.js';
import { createInstructionInventoryLoader } from '../composition/create-instruction-inventory-loader.js';
import { resolveRuntimeProjectPath } from '../composition/resolve-project-worktree-path.js';
import { loadSidebarModel } from '../application/use-cases/load-sidebar-model.js';
import { SidebarContent } from '../tui/components/sidebar-content.js';
import { emitSidebarRefresh } from '../tui/state/sidebar-refresh.js';

interface V2Location {
  readonly directory?: string;
  readonly worktree?: string;
  readonly project?: {
    readonly directory?: string;
  };
}

export interface OpenCodeV2TuiContext {
  readonly location?: V2Location;
  readonly theme: unknown;
  readonly data?: {
    readonly location?: {
      default(): V2Location | undefined;
    };
  };
  readonly ui: {
    toast: {
      show(input: { message: string; variant?: string }): void;
    };
    slot(input: {
      append: string;
      render(props: { sessionID: string }): unknown;
    }): (() => void) | void;
  };
  readonly keymap: {
    layer(definition: () => {
      mode: string;
      commands: Array<{
        id: string;
        title: string;
        description?: string;
        group?: string;
        palette?: boolean;
        run(): void;
      }>;
    }): (() => void) | void;
  };
}

export function createV2TuiSetup(options: CreateTuiPluginOptions = {}) {
  return function setup(context: OpenCodeV2TuiContext): () => void {
    const projectDirectory = resolveTuiProjectDirectory(context);
    const owner =
      options.createOwner?.(projectDirectory) ??
      createPlannerRuntimeOwner({
        createHandle: () => createPlannerRuntimeForWorktree(projectDirectory),
      });

    const unregisterSlot = context.ui.slot({
      append: 'sidebar.content',
      render: ({ sessionID }) => (
        <SidebarContent
          theme={adaptTheme(context.theme)}
          sessionId={sessionID}
          loadModel={sessionId =>
            loadSidebarModel({
              loadInventory: () => createInstructionInventoryLoader(projectDirectory)(),
              loadPlanningState: async () =>
                (await owner.getRuntime()).getActive({
                  worktreePath: projectDirectory,
                  opencodeSessionId: sessionId,
                }),
            })
          }
        />
      ),
    });

    const unregisterCommand = context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'brhp.refresh',
          title: 'Refresh BRHP sidebar',
          description: 'Reload instruction inventory from disk',
          group: 'Plugins',
          palette: true,
          run() {
            emitSidebarRefresh();
            context.ui.toast.show({
              variant: 'info',
              message: 'BRHP sidebar refresh requested',
            });
          },
        },
      ],
    }));

    return () => {
      if (typeof unregisterCommand === 'function') {
        unregisterCommand();
      }
      if (typeof unregisterSlot === 'function') {
        unregisterSlot();
      }
      void owner.dispose().catch(() => {
        context.ui.toast.show({
          variant: 'warning',
          message: 'BRHP planner runtime failed to close cleanly',
        });
      });
    };
  };
}

export const setup = createV2TuiSetup();

function resolveTuiProjectDirectory(context: OpenCodeV2TuiContext): string {
  const location = context.location ?? context.data?.location?.default();

  return resolveRuntimeProjectPath(
    location?.worktree,
    location?.project?.directory,
    location?.directory
  );
}

function adaptTheme(theme: unknown): TuiTheme {
  if (isLegacyTheme(theme)) {
    return theme;
  }

  const text =
    theme && typeof theme === 'object' && 'text' in theme
      ? ((theme as { text?: Record<string, unknown> }).text ?? {})
      : {};

  return {
    current: {
      text: color(text.base, text.primary, '#d7d7d7'),
      textMuted: color(text.muted, text.dim, '#8d8d8d'),
      error: color(text.danger, text.error, '#ff6b6b'),
    },
  } as unknown as TuiTheme;
}

function isLegacyTheme(theme: unknown): theme is TuiTheme {
  return Boolean(
    theme &&
      typeof theme === 'object' &&
      'current' in theme &&
      (theme as { current?: { text?: unknown } }).current?.text
  );
}

function color(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return '#d7d7d7';
}
