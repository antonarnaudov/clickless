// Key definitions for CDP Input.dispatchKeyEvent.

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const named: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
};
for (let i = 1; i <= 12; i++) named[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const PUNCT: Record<string, [string, number]> = {
  ';': ['Semicolon', 186], '=': ['Equal', 187], ',': ['Comma', 188], '-': ['Minus', 189], '.': ['Period', 190], '/': ['Slash', 191],
  '`': ['Backquote', 192], '[': ['BracketLeft', 219], '\\': ['Backslash', 220], ']': ['BracketRight', 221], "'": ['Quote', 222],
};

export function keyDef(name: string): KeyDef | null {
  const n = named[name.toLowerCase()];
  if (n) return n;
  if (name.length === 1) {
    const ch = name;
    const up = ch.toUpperCase();
    if (/[a-z]/i.test(ch)) return { key: ch, code: `Key${up}`, keyCode: up.charCodeAt(0), text: ch };
    if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    const p = PUNCT[ch];
    if (p) return { key: ch, code: p[0], keyCode: p[1], text: ch };
    return { key: ch, code: '', keyCode: 0, text: ch };
  }
  return null;
}

export const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

const MOD_ALIASES: Record<string, keyof typeof MOD> = {
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  control: 'Control', ctrl: 'Control',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta',
  shift: 'Shift',
};

export interface Combo {
  mods: number;
  modNames: (keyof typeof MOD)[];
  key: KeyDef;
}

/** "Meta+Shift+K", "ctrl+a", "Enter", "CmdOrCtrl+L" */
export function parseCombo(combo: string, platform: NodeJS.Platform): Combo {
  const raw = combo.trim();
  const parts = raw === '+' ? ['+'] : raw.split(/\+(?!$)/).map((p) => p.trim());
  const modNames: (keyof typeof MOD)[] = [];
  let key: KeyDef | null = null;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'cmdorctrl' || lower === 'commandorcontrol' || lower === 'mod') {
      modNames.push(platform === 'darwin' ? 'Meta' : 'Control');
      continue;
    }
    const m = MOD_ALIASES[lower];
    if (m && parts.length > 1) {
      modNames.push(m);
      continue;
    }
    key = keyDef(p);
    if (!key) throw new Error(`Unknown key “${p}”. Use names like Enter, Tab, Escape, ArrowDown, Backspace, a, Meta+A.`);
  }
  if (!key) throw new Error(`No key in “${combo}”`);
  let mods = 0;
  for (const m of modNames) mods |= MOD[m];
  return { mods, modNames, key };
}

/** macOS editing commands Chromium needs for Cmd+A/C/V/X/Z when keys are synthesized. */
export function macCommands(c: Combo): string[] | undefined {
  const k = c.key.key.toLowerCase();
  const meta = c.mods & MOD.Meta || c.mods & MOD.Control;
  if (!meta) return undefined;
  const shift = !!(c.mods & MOD.Shift);
  switch (k) {
    case 'a':
      return ['selectAll'];
    case 'c':
      return ['copy'];
    case 'x':
      return ['cut'];
    case 'v':
      return ['paste'];
    case 'z':
      return shift ? ['redo'] : ['undo'];
    case 'backspace':
      return ['deleteToBeginningOfLine'];
    case 'arrowleft':
      return shift ? ['moveToBeginningOfLineAndModifySelection'] : ['moveToBeginningOfLine'];
    case 'arrowright':
      return shift ? ['moveToEndOfLineAndModifySelection'] : ['moveToEndOfLine'];
  }
  return undefined;
}
