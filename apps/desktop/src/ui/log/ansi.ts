/**
 * ANSI SGR parser for terminal output. Produces styled segments; colors map to the --ansi-*
 * tokens (16-color), the xterm 256 palette or truecolor. Other escape sequences are stripped.
 */

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiSegment extends AnsiStyle {
  text: string;
}

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

function named(i: number, bright: boolean): string {
  return `var(--ansi-${bright ? "bright-" : ""}${NAMES[i]})`;
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** xterm 256-color palette index → CSS color. */
export function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 8) return named(n, false);
  if (n < 16) return named(n - 8, true);
  if (n < 232) {
    const i = n - 16;
    const r = CUBE[Math.floor(i / 36)] ?? 0;
    const g = CUBE[Math.floor(i / 6) % 6] ?? 0;
    const b = CUBE[i % 6] ?? 0;
    return `rgb(${r}, ${g}, ${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v}, ${v}, ${v})`;
}

// CSI ... final byte, OSC ... BEL/ST, and lone ESC + one char.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Remove all escape sequences (for copy/search). */
export function stripAnsi(input: string): string {
  return input.replace(ESCAPES, "");
}

function applySgr(params: number[], st: AnsiStyle): AnsiStyle {
  const s: AnsiStyle = { ...st };
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    if (p === 0) {
      for (const k of Object.keys(s)) delete s[k as keyof AnsiStyle];
    } else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 22) {
      s.bold = false;
      s.dim = false;
    } else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p === 29) s.strike = false;
    else if (p >= 30 && p <= 37) s.fg = named(p - 30, false);
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = named(p - 40, false);
    else if (p === 49) delete s.bg;
    else if (p >= 90 && p <= 97) s.fg = named(p - 90, true);
    else if (p >= 100 && p <= 107) s.bg = named(p - 100, true);
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let c: string | undefined;
      if (mode === 5) {
        c = color256(params[i + 2] ?? -1);
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        if ([r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255)) c = `rgb(${r}, ${g}, ${b})`;
        i += 4;
      }
      if (c) {
        if (p === 38) s.fg = c;
        else s.bg = c;
      }
    }
  }
  return s;
}

/**
 * Parse one line (or chunk). Pass the returned `state` into the next call to carry styles across
 * lines, like a terminal does.
 */
export function parseAnsi(input: string, state: AnsiStyle = {}): { segments: AnsiSegment[]; state: AnsiStyle } {
  const segments: AnsiSegment[] = [];
  let style = state;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = segments[segments.length - 1];
    if (prev && sameStyle(prev, style)) prev.text += text;
    else segments.push({ ...style, text });
  };
  ESCAPES.lastIndex = 0;
  for (let m = ESCAPES.exec(input); m; m = ESCAPES.exec(input)) {
    push(input.slice(last, m.index));
    last = m.index + m[0].length;
    const sgr = /^\x1b\[([0-9;:]*)m$/.exec(m[0]); // eslint-disable-line no-control-regex
    if (sgr) {
      const params = (sgr[1] ?? "")
        .split(/[;:]/)
        .filter((x, _i, arr) => x !== "" || arr.length === 1)
        .map((x) => (x === "" ? 0 : Number(x)));
      style = applySgr(params, style);
    }
  }
  push(input.slice(last));
  return { segments, state: style };
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse &&
    !!a.strike === !!b.strike
  );
}
