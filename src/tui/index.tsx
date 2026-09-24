/** @jsxImportSource @opentui/solid */
import { createTuiPlugin } from '../composition/create-tui-plugin.js';
import { setup } from '../v2/tui-setup.js';

const id = 'brhp' as const;

const tui = createTuiPlugin();

export default {
  id,
  setup,
  tui,
};
