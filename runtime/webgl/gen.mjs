// ops.tsv -> src/ops.rs and sdk/raea/src/webgl/ops.ts (run from anywhere: node runtime/webgl/gen.mjs)
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const ops = fs.readFileSync(path.join(here, "ops.tsv"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l, i) => { const [name, sig, ret] = l.split("\t"); return { n: i + 1, name, sig, ret }; });
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([0-9])([a-z])/g, "$1$2").toUpperCase();
fs.writeFileSync(path.join(here, "src/ops.rs"), `//! The WebGL ops by number: generated from ops.tsv by gen.mjs, never edited.\n\n${ops.map((o) => `pub const ${snake(o.name)}: u32 = ${o.n};`).join("\n")}\n\n/// Each op's name, operand letters and answer letter, by number (0 is no op).\npub const TABLE: [(&str, &str, &str); ${ops.length + 1}] = [\n    ("", "", ""),\n${ops.map((o) => `    ("${o.name}", "${o.sig}", "${o.ret}"),`).join("\n")}\n];\n`);
fs.writeFileSync(path.join(here, "../../sdk/raea/src/webgl/ops.ts"), `// The WebGL ops by number: generated from runtime/webgl/ops.tsv by gen.mjs, never edited.\nexport const OP = {\n${ops.map((o) => `  ${o.name}: ${o.n},`).join("\n")}\n} as const;\n/** each op's operand letters and answer letter, by number */\nexport const SIG: readonly (readonly [string, string])[] = [["", ""], ${ops.map((o) => `["${o.sig}", "${o.ret}"]`).join(", ")}];\n`);
console.log(ops.length, "ops");
