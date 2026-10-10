// Go flag package semantics: -name value, -name=value, --name; parsing stops
// at the first non-flag argument or "--".

export type FlagSpec = Record<string, { type: "string" | "int" | "bool"; usage: string; default?: string | number | boolean }>;

export class FlagError extends Error {}

export function parseFlags<S extends FlagSpec>(args: string[], spec: S) {
  const values: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(spec)) if (v.default !== undefined) values[k] = v.default;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    let name = a.replace(/^--?/, "");
    let val: string | undefined;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      val = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name === "h" || name === "help") throw new FlagError("help");
    const s = spec[name];
    if (!s) throw new FlagError(`flag provided but not defined: -${name}`);
    if (s.type === "bool") {
      values[name] = val === undefined ? true : val === "true" || val === "1";
      continue;
    }
    if (val === undefined) {
      if (i + 1 >= args.length) throw new FlagError(`flag needs an argument: -${name}`);
      val = args[++i]!;
    }
    if (s.type === "int") {
      const n = Number(val);
      if (!Number.isInteger(n)) throw new FlagError(`invalid value "${val}" for flag -${name}: parse error`);
      values[name] = n;
    } else values[name] = val;
  }
  return { values: values as { [K in keyof S]: S[K]["type"] extends "int" ? number : S[K]["type"] extends "bool" ? boolean : string }, rest: args.slice(i) };
}

export function usageLines(spec: FlagSpec): string {
  return Object.entries(spec)
    .map(([k, v]) => {
      const kind = v.type === "bool" ? "" : ` ${v.type === "int" ? "int" : "string"}`;
      const def = v.default !== undefined && v.default !== "" && v.default !== false ? ` (default ${JSON.stringify(v.default)})` : "";
      return `  -${k}${kind}\n    \t${v.usage}${def}`;
    })
    .join("\n");
}
