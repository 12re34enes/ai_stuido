/**
 * Guards the token file: the light, dark and system-dark palettes must declare the same
 * variables, and the two dark blocks must be identical (they are duplicated by necessity).
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs from apps/desktop.
const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");

function block(startMarker: string): Map<string, string> {
  const start = css.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const open = css.indexOf("{", start + startMarker.length - 1);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

const light = block(':root,\n[data-theme="light"] {');
const dark = block(':root[data-theme="dark"],\n[data-theme="dark"] {');
const systemDark = block(':root:not([data-theme="light"]) {');

describe("design tokens", () => {
  it("declares the same palette variables in light and dark", () => {
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  it("keeps the system-dark block identical to the forced dark block", () => {
    expect(Object.fromEntries(systemDark)).toEqual(Object.fromEntries(dark));
  });

  it("defines the core surfaces, provider and environment colors", () => {
    for (const name of ["--canvas", "--surface", "--fg", "--accent", "--claude", "--codex", "--env-production", "--diff-add-bg", "--ansi-red"]) {
      expect(light.has(name)).toBe(true);
    }
  });
});
