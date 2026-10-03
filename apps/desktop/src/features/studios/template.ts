/**
 * A small, safe Jinja2 subset for rendering a studio's `output_template` into the final document
 * (the engine stores node outputs but does not render the template). Supported:
 *
 *   {{ expr }}  {% if / elif / else / endif %}  {% for x in xs %}…{% else %}…{% endfor %}
 *   {% set x = expr %}  {# comments #}  whitespace control with "-"
 *   expressions: names, .attr, ["key"], literals, lists, not/and/or, == != < > <= >= in, ~ + - * /,
 *   `is [not] defined|none|string|number`, filters (trim, length, default, replace, truncate,
 *   upper, lower, capitalize, title, join, first, last, int, float, string, round, abs, indent,
 *   wordcount, safe, e).
 *
 * Undefined values are chainable (`nodes.missing.output` renders empty) so a template that names
 * a skipped node still produces a document. Nothing is evaluated as code.
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

class UndefinedValue {
  toString() {
    return "";
  }
}
export const UNDEFINED = new UndefinedValue();

type Value = unknown;
type Scope = Record<string, Value>;

// ----------------------------------------------------------------------------- lexer (template)

type Chunk = { type: "text"; text: string } | { type: "expr"; code: string } | { type: "stmt"; code: string };

function chunks(source: string): Chunk[] {
  const out: Chunk[] = [];
  const re = /\{(\{|%|#)(-?)([\s\S]*?)(-?)(\}\}|%\}|#\})/g;
  let last = 0;
  let stripNext = false;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const [whole, open, lstrip, inner, rstrip, close] = m;
    const expected = open === "{" ? "}}" : open === "%" ? "%}" : "#}";
    if (close !== expected) throw new TemplateError(`Kapanmamış şablon etiketi: ${whole.slice(0, 20)}`);
    let text = source.slice(last, m.index);
    if (stripNext) text = text.replace(/^\s+/, "");
    if (lstrip) text = text.replace(/\s+$/, "");
    if (text) out.push({ type: "text", text });
    if (open === "{") out.push({ type: "expr", code: inner! });
    else if (open === "%") out.push({ type: "stmt", code: inner!.trim() });
    stripNext = rstrip === "-";
    last = m.index + whole.length;
  }
  let tail = source.slice(last);
  if (stripNext) tail = tail.replace(/^\s+/, "");
  if (/\{[{%]/.test(tail)) throw new TemplateError("Kapanmamış şablon etiketi.");
  if (tail) out.push({ type: "text", text: tail });
  return out;
}

// ----------------------------------------------------------------------------- lexer (expressions)

type Tok = { t: "name" | "str" | "num" | "op" | "end"; v: string };

function tokenize(code: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[A-Za-z0-9_]/.test(code[j]!)) j++;
      toks.push({ t: "name", v: code.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[0-9_.]/.test(code[j]!)) j++;
      toks.push({ t: "num", v: code.slice(i, j).replace(/_/g, "") });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = "";
      while (j < code.length && code[j] !== ch) {
        if (code[j] === "\\" && j + 1 < code.length) {
          const n = code[j + 1]!;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          j += 2;
        } else s += code[j++];
      }
      if (j >= code.length) throw new TemplateError("Kapanmamış metin.");
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const two = code.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "//"].includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("()[].,|~+-*/%<>=:".includes(ch)) {
      toks.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new TemplateError(`Beklenmeyen karakter: ${ch}`);
  }
  toks.push({ t: "end", v: "" });
  return toks;
}

// ----------------------------------------------------------------------------- expression AST

type Expr =
  | { k: "lit"; v: Value }
  | { k: "name"; n: string }
  | { k: "attr"; o: Expr; n: string }
  | { k: "item"; o: Expr; i: Expr }
  | { k: "list"; items: Expr[] }
  | { k: "not"; e: Expr }
  | { k: "neg"; e: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "test"; e: Expr; name: string; negate: boolean }
  | { k: "filter"; e: Expr; name: string; args: Expr[]; kwargs: Record<string, Expr> };

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)]!;
  }
  private next(): Tok {
    return this.toks[this.i++] ?? { t: "end", v: "" };
  }
  private isOp(v: string) {
    const p = this.peek();
    return p.t === "op" && p.v === v;
  }
  private isName(v: string) {
    const p = this.peek();
    return p.t === "name" && p.v === v;
  }
  private expectOp(v: string) {
    const t = this.next();
    if (t.t !== "op" || t.v !== v) throw new TemplateError(`“${v}” bekleniyordu.`);
  }
  name(): string {
    const t = this.next();
    if (t.t !== "name") throw new TemplateError("Ad bekleniyordu.");
    return t.v;
  }
  done(): boolean {
    return this.peek().t === "end";
  }
  expectName(v: string) {
    const t = this.next();
    if (t.t !== "name" || t.v !== v) throw new TemplateError(`“${v}” bekleniyordu.`);
  }

  expr(): Expr {
    return this.or();
  }
  private or(): Expr {
    let a = this.and();
    while (this.isName("or")) {
      this.next();
      a = { k: "bin", op: "or", a, b: this.and() };
    }
    return a;
  }
  private and(): Expr {
    let a = this.not();
    while (this.isName("and")) {
      this.next();
      a = { k: "bin", op: "and", a, b: this.not() };
    }
    return a;
  }
  private not(): Expr {
    if (this.isName("not")) {
      this.next();
      return { k: "not", e: this.not() };
    }
    return this.compare();
  }
  private compare(): Expr {
    let a = this.concat();
    for (;;) {
      const p = this.peek();
      if (p.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(p.v)) {
        this.next();
        a = { k: "bin", op: p.v, a, b: this.concat() };
      } else if (this.isName("in")) {
        this.next();
        a = { k: "bin", op: "in", a, b: this.concat() };
      } else if (this.isName("not") && this.peek(1).t === "name" && this.peek(1).v === "in") {
        this.next();
        this.next();
        a = { k: "not", e: { k: "bin", op: "in", a, b: this.concat() } };
      } else if (this.isName("is")) {
        this.next();
        let negate = false;
        if (this.isName("not")) {
          this.next();
          negate = true;
        }
        a = { k: "test", e: a, name: this.name(), negate };
      } else return a;
    }
  }
  private concat(): Expr {
    let a = this.additive();
    while (this.isOp("~")) {
      this.next();
      a = { k: "bin", op: "~", a, b: this.additive() };
    }
    return a;
  }
  private additive(): Expr {
    let a = this.mult();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().v;
      a = { k: "bin", op, a, b: this.mult() };
    }
    return a;
  }
  private mult(): Expr {
    let a = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("//") || this.isOp("%")) {
      const op = this.next().v;
      a = { k: "bin", op, a, b: this.unary() };
    }
    return a;
  }
  private unary(): Expr {
    if (this.isOp("-")) {
      this.next();
      return { k: "neg", e: this.unary() };
    }
    return this.postfix();
  }
  private args(): { args: Expr[]; kwargs: Record<string, Expr> } {
    const args: Expr[] = [];
    const kwargs: Record<string, Expr> = {};
    this.expectOp("(");
    while (!this.isOp(")")) {
      if (this.peek().t === "name" && this.peek(1).t === "op" && this.peek(1).v === "=") {
        const key = this.name();
        this.next();
        kwargs[key] = this.expr();
      } else args.push(this.expr());
      if (this.isOp(",")) this.next();
      else break;
    }
    this.expectOp(")");
    return { args, kwargs };
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const t = this.next();
        if (t.t !== "name" && t.t !== "num") throw new TemplateError("Nitelik adı bekleniyordu.");
        e = { k: "attr", o: e, n: t.v };
      } else if (this.isOp("[")) {
        this.next();
        const i = this.expr();
        this.expectOp("]");
        e = { k: "item", o: e, i };
      } else if (this.isOp("|")) {
        this.next();
        const name = this.name();
        const { args, kwargs } = this.isOp("(") ? this.args() : { args: [], kwargs: {} };
        e = { k: "filter", e, name, args, kwargs };
      } else return e;
    }
  }
  private primary(): Expr {
    const t = this.next();
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "name") {
      if (t.v === "true" || t.v === "True") return { k: "lit", v: true };
      if (t.v === "false" || t.v === "False") return { k: "lit", v: false };
      if (t.v === "none" || t.v === "None") return { k: "lit", v: null };
      return { k: "name", n: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      const e = this.expr();
      this.expectOp(")");
      return e;
    }
    if (t.t === "op" && t.v === "[") {
      const items: Expr[] = [];
      while (!this.isOp("]")) {
        items.push(this.expr());
        if (this.isOp(",")) this.next();
        else break;
      }
      this.expectOp("]");
      return { k: "list", items };
    }
    throw new TemplateError("Geçersiz ifade.");
  }
}

function parseExpr(code: string): Expr {
  const p = new Parser(tokenize(code));
  const e = p.expr();
  if (!p.done()) throw new TemplateError(`İfade çözümlenemedi: ${code.trim()}`);
  return e;
}

// ----------------------------------------------------------------------------- evaluation

export function truthy(v: Value): boolean {
  if (v === UNDEFINED || v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export function toText(v: Value): string {
  if (v === UNDEFINED || v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function lengthOf(v: Value): number {
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (v && typeof v === "object" && v !== UNDEFINED) return Object.keys(v).length;
  return 0;
}

function getAttr(o: Value, key: string | number): Value {
  if (o === UNDEFINED || o === null || o === undefined) return UNDEFINED;
  if (typeof o === "string" && typeof key === "number") return o[key] ?? UNDEFINED;
  if (Array.isArray(o)) {
    const i = typeof key === "number" ? key : Number(key);
    if (Number.isInteger(i)) return o[i < 0 ? o.length + i : i] ?? UNDEFINED;
    return UNDEFINED;
  }
  if (typeof o === "object" && Object.prototype.hasOwnProperty.call(o, key)) return (o as Record<string, Value>)[String(key)];
  return UNDEFINED;
}

function jinjaTruncate(s: string, length = 255, killwords = false, end = "...", leeway = 5): string {
  if (s.length <= length + leeway) return s;
  if (killwords) return s.slice(0, length - end.length) + end;
  const cut = s.slice(0, Math.max(0, length - end.length));
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut) + end;
}

function applyFilter(name: string, v: Value, args: Value[], kwargs: Record<string, Value>): Value {
  const arg = (i: number, key: string, fallback: Value) => (args.length > i ? args[i] : key in kwargs ? kwargs[key] : fallback);
  switch (name) {
    case "trim":
      return toText(v).trim();
    case "length":
    case "count":
      return lengthOf(v);
    case "default":
    case "d": {
      const boolean = truthy(arg(1, "boolean", false));
      return v === UNDEFINED || (boolean && !truthy(v)) ? arg(0, "default_value", "") : v;
    }
    case "replace": {
      const from = toText(arg(0, "old", ""));
      return from ? toText(v).split(from).join(toText(arg(1, "new", ""))) : toText(v);
    }
    case "truncate":
      return jinjaTruncate(toText(v), Number(arg(0, "length", 255)), truthy(arg(1, "killwords", false)), toText(arg(2, "end", "...")), Number(arg(3, "leeway", 5)));
    case "upper":
      return toText(v).toLocaleUpperCase("tr-TR");
    case "lower":
      return toText(v).toLocaleLowerCase("tr-TR");
    case "capitalize": {
      const t = toText(v);
      return t.charAt(0).toLocaleUpperCase("tr-TR") + t.slice(1).toLocaleLowerCase("tr-TR");
    }
    case "title":
      return toText(v).replace(/\S+/g, (w) => w.charAt(0).toLocaleUpperCase("tr-TR") + w.slice(1).toLocaleLowerCase("tr-TR"));
    case "join":
      return Array.isArray(v) ? v.map(toText).join(toText(arg(0, "d", ""))) : toText(v);
    case "first":
      return Array.isArray(v) ? (v[0] ?? UNDEFINED) : typeof v === "string" ? (v[0] ?? UNDEFINED) : UNDEFINED;
    case "last":
      return Array.isArray(v) ? (v[v.length - 1] ?? UNDEFINED) : typeof v === "string" ? (v[v.length - 1] ?? UNDEFINED) : UNDEFINED;
    case "int": {
      const n = parseInt(toText(v), 10);
      return Number.isNaN(n) ? Number(arg(0, "default", 0)) : n;
    }
    case "float": {
      const n = parseFloat(toText(v));
      return Number.isNaN(n) ? Number(arg(0, "default", 0)) : n;
    }
    case "round": {
      const p = Number(arg(0, "precision", 0));
      const f = 10 ** p;
      return Math.round(Number(v) * f) / f;
    }
    case "abs":
      return Math.abs(Number(v));
    case "string":
      return toText(v);
    case "list":
      return Array.isArray(v) ? v : typeof v === "string" ? [...v] : [];
    case "wordcount":
      return toText(v).split(/\s+/).filter(Boolean).length;
    case "indent": {
      const width = Number(arg(0, "width", 4));
      const pad = " ".repeat(width);
      return toText(v).replace(/\n(?!$)/g, `\n${pad}`);
    }
    case "safe":
    case "e":
    case "escape":
      return v;
    default:
      throw new TemplateError(`Bilinmeyen filtre: ${name}`);
  }
}

function evaluate(e: Expr, scope: Scope): Value {
  switch (e.k) {
    case "lit":
      return e.v;
    case "name":
      return Object.prototype.hasOwnProperty.call(scope, e.n) ? scope[e.n] : UNDEFINED;
    case "attr":
      return getAttr(evaluate(e.o, scope), /^\d+$/.test(e.n) ? Number(e.n) : e.n);
    case "item": {
      const key = evaluate(e.i, scope);
      return getAttr(evaluate(e.o, scope), typeof key === "number" ? key : toText(key));
    }
    case "list":
      return e.items.map((x) => evaluate(x, scope));
    case "not":
      return !truthy(evaluate(e.e, scope));
    case "neg":
      return -Number(evaluate(e.e, scope));
    case "test": {
      const v = evaluate(e.e, scope);
      let r: boolean;
      if (e.name === "defined") r = v !== UNDEFINED;
      else if (e.name === "undefined") r = v === UNDEFINED;
      else if (e.name === "none") r = v === null;
      else if (e.name === "string") r = typeof v === "string";
      else if (e.name === "number") r = typeof v === "number";
      else throw new TemplateError(`Bilinmeyen test: ${e.name}`);
      return e.negate ? !r : r;
    }
    case "filter":
      return applyFilter(
        e.name,
        evaluate(e.e, scope),
        e.args.map((a) => evaluate(a, scope)),
        Object.fromEntries(Object.entries(e.kwargs).map(([k, a]) => [k, evaluate(a, scope)])),
      );
    case "bin": {
      if (e.op === "and") {
        const a = evaluate(e.a, scope);
        return truthy(a) ? evaluate(e.b, scope) : a;
      }
      if (e.op === "or") {
        const a = evaluate(e.a, scope);
        return truthy(a) ? a : evaluate(e.b, scope);
      }
      const a = evaluate(e.a, scope);
      const b = evaluate(e.b, scope);
      switch (e.op) {
        case "==":
          return a === b || (a === UNDEFINED && b === UNDEFINED);
        case "!=":
          return a !== b;
        case "<":
          return (a as number) < (b as number);
        case ">":
          return (a as number) > (b as number);
        case "<=":
          return (a as number) <= (b as number);
        case ">=":
          return (a as number) >= (b as number);
        case "in":
          if (typeof b === "string") return b.includes(toText(a));
          if (Array.isArray(b)) return b.includes(a);
          if (b && typeof b === "object" && b !== UNDEFINED) return Object.prototype.hasOwnProperty.call(b, toText(a));
          return false;
        case "~":
          return toText(a) + toText(b);
        case "+":
          return typeof a === "number" && typeof b === "number" ? a + b : toText(a) + toText(b);
        case "-":
          return Number(a) - Number(b);
        case "*":
          return typeof a === "string" ? a.repeat(Number(b)) : Number(a) * Number(b);
        case "/":
          return Number(a) / Number(b);
        case "//":
          return Math.floor(Number(a) / Number(b));
        case "%":
          return Number(a) % Number(b);
      }
      throw new TemplateError(`Bilinmeyen işleç: ${e.op}`);
    }
  }
}

// ----------------------------------------------------------------------------- statements

type Node =
  | { k: "text"; text: string }
  | { k: "out"; e: Expr }
  | { k: "if"; branches: { cond: Expr; body: Node[] }[]; otherwise: Node[] }
  | { k: "for"; vars: string[]; iter: Expr; body: Node[]; otherwise: Node[] }
  | { k: "set"; name: string; e: Expr };

function build(list: Chunk[]): Node[] {
  let i = 0;
  function block(terminators: string[]): { nodes: Node[]; end: string } {
    const nodes: Node[] = [];
    while (i < list.length) {
      const c = list[i++]!;
      if (c.type === "text") nodes.push({ k: "text", text: c.text });
      else if (c.type === "expr") nodes.push({ k: "out", e: parseExpr(c.code) });
      else {
        const word = c.code.split(/\s+/)[0] ?? "";
        if (terminators.includes(word)) {
          i--;
          return { nodes, end: word };
        }
        if (word === "if") {
          const branches: { cond: Expr; body: Node[] }[] = [];
          let cond = parseExpr(c.code.slice(2));
          let otherwise: Node[] = [];
          for (;;) {
            // `block` stops *at* the terminator; consume it here.
            const r = block(["elif", "else", "endif"]);
            branches.push({ cond, body: r.nodes });
            const stmt = list[i++] as Extract<Chunk, { type: "stmt" }>;
            if (r.end === "elif") {
              cond = parseExpr(stmt.code.slice(4));
              continue;
            }
            if (r.end === "else") {
              otherwise = block(["endif"]).nodes;
              i++;
            }
            break;
          }
          nodes.push({ k: "if", branches, otherwise });
        } else if (word === "for") {
          const m = /^for\s+([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)*)\s+in\s+([\s\S]+)$/.exec(c.code);
          if (!m) throw new TemplateError("Geçersiz “for” ifadesi.");
          const r = block(["else", "endfor"]);
          let otherwise: Node[] = [];
          i++;
          if (r.end === "else") {
            otherwise = block(["endfor"]).nodes;
            i++;
          }
          nodes.push({ k: "for", vars: m[1]!.split(",").map((v) => v.trim()), iter: parseExpr(m[2]!), body: r.nodes, otherwise });
        } else if (word === "set") {
          const m = /^set\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(c.code);
          if (!m) throw new TemplateError("Geçersiz “set” ifadesi.");
          nodes.push({ k: "set", name: m[1]!, e: parseExpr(m[2]!) });
        } else throw new TemplateError(`Desteklenmeyen şablon komutu: ${word}`);
      }
    }
    if (terminators.length) throw new TemplateError(`“${terminators[terminators.length - 1]}” eksik.`);
    return { nodes, end: "" };
  }
  return block([]).nodes;
}

function run(nodes: Node[], scope: Scope): string {
  let out = "";
  for (const n of nodes) {
    if (n.k === "text") out += n.text;
    else if (n.k === "out") out += toText(evaluate(n.e, scope));
    else if (n.k === "set") scope[n.name] = evaluate(n.e, scope);
    else if (n.k === "if") {
      const hit = n.branches.find((b) => truthy(evaluate(b.cond, scope)));
      out += run(hit ? hit.body : n.otherwise, scope);
    } else {
      const iter = evaluate(n.iter, scope);
      const items: Value[] = Array.isArray(iter)
        ? iter
        : iter && typeof iter === "object" && iter !== UNDEFINED
          ? Object.keys(iter)
          : typeof iter === "string"
            ? [...iter]
            : [];
      if (items.length === 0) {
        out += run(n.otherwise, scope);
        continue;
      }
      items.forEach((item, index) => {
        const inner: Scope = Object.create(scope) as Scope;
        Object.assign(inner, scope);
        if (n.vars.length === 1) inner[n.vars[0]!] = item;
        else n.vars.forEach((v, j) => (inner[v] = Array.isArray(item) ? item[j] : UNDEFINED));
        inner.loop = { index: index + 1, index0: index, first: index === 0, last: index === items.length - 1, length: items.length };
        out += run(n.body, inner);
      });
    }
  }
  return out;
}

/** Render `source` with `context`. Throws TemplateError (Turkish message) on unsupported syntax. */
export function renderTemplate(source: string, context: Scope): string {
  return run(build(chunks(source)), { ...context });
}
