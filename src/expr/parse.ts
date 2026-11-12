/**
 * The expression language of flows: values and conditions only, never data access or control flow
 * (those are flow steps). The grammar started as the one of Ankpal's report designer (RDL2):
 *
 *   data.status = 'active' and row.amount > 1000
 *   data.invoiceDate between @from and @to
 *   lower(data.name) contains 'traders'
 *   data.branchId in (1, 2, 3)
 *   if(before.balance < 0, -before.balance, 0)
 *   coalesce(data.discount, 0) + round(data.tax * 1.18, 2)
 *
 * Parsing is shared; `evaluate()` runs an expression in memory (flows). Nothing is ever passed to
 * `eval` or `Function`, functions come from a fixed list (extended with `defineExpressionFunction`),
 * and length and nesting are limited, so a definition cannot carry code.
 */

export class ExpressionError extends Error {}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'param'; v: string }
  | { t: 'op'; v: string }
  | { t: 'word'; v: string }
  | { t: '('; v: '(' }
  | { t: ')'; v: ')' }
  | { t: ','; v: ',' }
  | { t: 'end'; v: '' };

const WORDS = new Set(['and', 'or', 'not', 'between', 'in', 'is', 'null', 'empty', 'true', 'false', 'contains', 'starts', 'ends', 'like']);
const MAX_LENGTH = 2000;
const MAX_DEPTH = 40;

export type Ast =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'name'; v: string }
  | { k: 'param'; v: string }
  | { k: 'neg'; v: Ast }
  | { k: 'not'; v: Ast }
  | { k: 'bin'; op: string; l: Ast; r: Ast }
  | { k: 'between'; v: Ast; lo: Ast; hi: Ast; not: boolean }
  | { k: 'in'; v: Ast; items: Ast[] | Ast; not: boolean }
  | { k: 'isnull'; v: Ast; not: boolean; empty: boolean }
  | { k: 'text'; op: 'contains' | 'starts' | 'ends'; v: Ast; arg: Ast; not: boolean }
  | { k: 'call'; fn: string; args: Ast[] };

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LENGTH) throw new ExpressionError(`Expression is longer than ${MAX_LENGTH} characters`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c, v: c } as Tok);
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length) {
        if (src[j] === c && src[j + 1] === c) {
          v += c;
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        v += src[j];
        j += 1;
      }
      if (j >= src.length) throw new ExpressionError('A text value is not closed with a quote');
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      out.push({ t: 'num', v: Number(m![0]) });
      i += m![0].length;
      continue;
    }
    if (c === '@') {
      const m = /^@([A-Za-z_]\w*)/.exec(src.slice(i));
      if (!m) throw new ExpressionError('A parameter is written @name');
      out.push({ t: 'param', v: m[1]! });
      i += m[0].length;
      continue;
    }
    const op = /^(>=|<=|!=|<>|=|>|<|\+|-|\*|\/|%)/.exec(src.slice(i));
    if (op) {
      out.push({ t: 'op', v: op[0] === '<>' ? '!=' : op[0] });
      i += op[0].length;
      continue;
    }
    const name = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*/.exec(src.slice(i));
    if (name) {
      const lower = name[0].toLowerCase();
      if (WORDS.has(lower)) out.push({ t: 'word', v: lower });
      else out.push({ t: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${c}"`);
  }
  out.push({ t: 'end', v: '' });
  return out;
}

class Parser {
  private at = 0;
  private depth = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.at]!;
  }
  private next(): Tok {
    return this.toks[this.at++]!;
  }
  private isWord(w: string): boolean {
    const t = this.peek();
    return t.t === 'word' && t.v === w;
  }
  private eatWord(w: string): boolean {
    if (!this.isWord(w)) return false;
    this.at += 1;
    return true;
  }
  private expect(t: Tok['t']): void {
    if (this.peek().t !== t) throw new ExpressionError(`Expected "${t}"`);
    this.at += 1;
  }

  parse(): Ast {
    const ast = this.or();
    if (this.peek().t !== 'end') throw new ExpressionError('Unexpected text after the expression');
    return ast;
  }

  private guard<T>(fn: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ExpressionError('Expression is nested too deeply');
    try {
      return fn();
    } finally {
      this.depth -= 1;
    }
  }

  private or(): Ast {
    let l = this.and();
    while (this.eatWord('or')) l = { k: 'bin', op: 'or', l, r: this.and() };
    return l;
  }
  private and(): Ast {
    let l = this.not();
    while (this.eatWord('and')) l = { k: 'bin', op: 'and', l, r: this.not() };
    return l;
  }
  private not(): Ast {
    if (this.eatWord('not')) return this.guard(() => ({ k: 'not', v: this.not() }));
    return this.cmp();
  }
  private cmp(): Ast {
    const l = this.add();
    const t = this.peek();
    if (t.t === 'op' && ['=', '!=', '>', '>=', '<', '<='].includes(t.v)) {
      this.next();
      return { k: 'bin', op: t.v, l, r: this.add() };
    }
    const negated = this.isWord('not') && this.toks[this.at + 1]?.t === 'word';
    if (negated) this.next();
    if (this.eatWord('between')) {
      const lo = this.add();
      if (!this.eatWord('and')) throw new ExpressionError('between needs "and"');
      return { k: 'between', v: l, lo, hi: this.add(), not: negated };
    }
    if (this.eatWord('in')) {
      if (this.peek().t === 'param') return { k: 'in', v: l, items: this.primary(), not: negated };
      // `x in under(@groups)`: the chosen tree rows and every row under them (account groups).
      const next = this.peek();
      if (next.t === 'name' && next.v.toLowerCase() === 'under') {
        const call = this.primary();
        if (call.k !== 'call' || call.args.length !== 1 || call.args[0]!.k !== 'param') throw new ExpressionError('under() takes one input, such as under(@groups)');
        return { k: 'in', v: l, items: call, not: negated };
      }
      this.expect('(');
      const items: Ast[] = [this.add()];
      while (this.peek().t === ',') {
        this.next();
        items.push(this.add());
      }
      this.expect(')');
      return { k: 'in', v: l, items, not: negated };
    }
    for (const op of ['contains', 'starts', 'ends'] as const) {
      if (this.eatWord(op)) return { k: 'text', op, v: l, arg: this.add(), not: negated };
    }
    if (negated) throw new ExpressionError('"not" must come before between, in, contains, starts or ends');
    if (this.eatWord('is')) {
      const not = this.eatWord('not');
      if (this.eatWord('null')) return { k: 'isnull', v: l, not, empty: false };
      if (this.eatWord('empty')) return { k: 'isnull', v: l, not, empty: true };
      throw new ExpressionError('"is" is followed by null or empty');
    }
    return l;
  }
  private add(): Ast {
    let l = this.mul();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.v !== '+' && t.v !== '-')) return l;
      this.next();
      l = { k: 'bin', op: t.v, l, r: this.mul() };
    }
  }
  private mul(): Ast {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.v !== '*' && t.v !== '/' && t.v !== '%')) return l;
      this.next();
      l = { k: 'bin', op: t.v, l, r: this.unary() };
    }
  }
  private unary(): Ast {
    const t = this.peek();
    if (t.t === 'op' && t.v === '-') {
      this.next();
      return this.guard(() => ({ k: 'neg', v: this.unary() }));
    }
    return this.primary();
  }
  private primary(): Ast {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'param') return { k: 'param', v: t.v };
    if (t.t === 'word' && (t.v === 'true' || t.v === 'false')) return { k: 'bool', v: t.v === 'true' };
    if (t.t === 'word' && t.v === 'null') return { k: 'null' };
    if (t.t === '(') {
      const inner = this.guard(() => this.or());
      this.expect(')');
      return inner;
    }
    if (t.t === 'name') {
      if (this.peek().t === '(') {
        this.next();
        const args: Ast[] = [];
        if (this.peek().t !== ')') {
          args.push(this.guard(() => this.or()));
          while (this.peek().t === ',') {
            this.next();
            args.push(this.guard(() => this.or()));
          }
        }
        this.expect(')');
        return { k: 'call', fn: t.v.toLowerCase(), args };
      }
      return { k: 'name', v: t.v };
    }
    throw new ExpressionError('Expected a value, a name, a parameter or "("');
  }
}

export function parseExpression(src: string): Ast {
  return new Parser(tokenize(src)).parse();
}

/** Every name an expression reads (`data.name`, `lookup.id`), for checks at boot. */
export function expressionNames(ast: Ast, out: Set<string> = new Set()): Set<string> {
  const walk = (node: Ast): void => {
    switch (node.k) {
      case 'name':
        out.add(node.v);
        break;
      case 'neg':
      case 'not':
      case 'isnull':
        walk(node.v);
        break;
      case 'bin':
        walk(node.l);
        walk(node.r);
        break;
      case 'between':
        [node.v, node.lo, node.hi].forEach(walk);
        break;
      case 'in':
        walk(node.v);
        (Array.isArray(node.items) ? node.items : [node.items]).forEach(walk);
        break;
      case 'text':
        walk(node.v);
        walk(node.arg);
        break;
      case 'call':
        node.args.forEach(walk);
        break;
      default:
        break;
    }
  };
  walk(ast);
  return out;
}
