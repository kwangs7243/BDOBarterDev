import { createHash } from "node:crypto";

export const normalizeTextEol = (text) => text.replace(/\r\n/g, "\n");

export const normalizeFunctionBody = normalizeTextEol;

export const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export const sha256TextEol = (text) => sha256(normalizeTextEol(text));

export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

function skipQuoted(source, start, quote) {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") { i += 1; continue; }
    if (source[i] === quote) return i + 1;
  }
  throw new Error(`Unterminated ${quote} literal`);
}

function skipRegex(source, start) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") { i += 1; continue; }
    if (source[i] === "[") inClass = true;
    else if (source[i] === "]") inClass = false;
    else if (source[i] === "/" && !inClass) {
      while (/[a-z]/i.test(source[i + 1] || "")) i += 1;
      return i + 1;
    } else if (source[i] === "\n") break;
  }
  return start + 1;
}

function regexCanStart(source, slash) {
  let i = slash - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  const before = source.slice(Math.max(0, i - 12), i + 1);
  const ch = source[i];
  return ch === undefined || "=(:,[!&|?{};".includes(ch) || /\b(return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(before);
}

export function findMatchingBrace(source, open) {
  if (source[open] !== "{") throw new Error("Expected opening brace");
  let depth = 1;
  for (let i = open + 1; i < source.length;) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") { i = skipQuoted(source, i, ch); continue; }
    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i + 2); i = newline < 0 ? source.length : newline + 1; continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2); if (close < 0) throw new Error("Unterminated block comment"); i = close + 2; continue;
    }
    if (ch === "/" && regexCanStart(source, i)) { i = skipRegex(source, i); continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return i;
    i += 1;
  }
  throw new Error("Unbalanced function body");
}

export function findFunctionDefinitions(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${escaped}\\s*\\(`, "g"),
    new RegExp(`(?:^|\\n)\\s*window\\.${escaped}\\s*=\\s*function\\s*\\(`, "g"),
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const marker = match[0].includes("window.") ? "window." : "function";
      const start = match.index + match[0].lastIndexOf(marker);
      const open = source.indexOf("{", match.index + match[0].length);
      const close = findMatchingBrace(source, open);
      const line = source.slice(0, start).split("\n").length;
      found.push({ name, start, open, close, line, source: source.slice(start, close + 1), body: source.slice(open + 1, close) });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export function findVariableDeclaration(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:const|let|var)\\s+${escaped}\\s*=`, "g");
  const matches = [...source.matchAll(pattern)];
  if (!matches.length) throw new Error(`Variable declaration missing: ${name}`);
  const match = matches.at(-1);
  const marker = new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=`).exec(match[0])[0];
  const start = match.index + match[0].lastIndexOf(marker);
  const expressionStart = start + marker.length;
  let cursor = expressionStart;
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  let end;
  if (source[cursor] === "{") {
    const close = findMatchingBrace(source, cursor);
    end = close + 1;
  } else {
    const semicolon = source.indexOf(";", cursor);
    if (semicolon < 0) throw new Error(`Statement terminator missing: ${name}`);
    end = semicolon;
  }
  if (source[end] === ";") end += 1;
  return { name, start, end, line: source.slice(0, start).split("\n").length, source: source.slice(start, end) };
}
