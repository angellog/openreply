/**
 * Reading and writing the on-disk `.env`, without destroying it.
 *
 * The Setup Console edits a file a human also edits by hand, so a naive
 * "serialize a key/value map" write would silently eat every comment and every
 * variable the console does not know about. Instead the file is parsed into an
 * ordered line list, values are patched in place, and only genuinely new keys
 * are appended. Round-tripping a file the console never touched must produce
 * byte-identical output — `__tests__/setup-env-file.test.ts` pins that.
 */

import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { GeneratorKind } from "@/lib/setup/fields";

export interface ParsedEnvLine {
  /** The raw source line, kept verbatim for anything we do not rewrite. */
  raw: string;
  /** Set only for lines that assign a variable. */
  key?: string;
  value?: string;
}

export interface ParsedEnvFile {
  lines: ParsedEnvLine[];
  values: Record<string, string>;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function getEnvFilePath(): string {
  return process.env.SETUP_ENV_FILE ?? path.join(process.cwd(), ".env");
}

/**
 * Strip dotenv quoting from a raw right-hand side.
 *
 * Unquoted values keep an inline `# comment` out of the value, but only when
 * the hash is preceded by whitespace — `re_ab#cd` is a legitimate secret, while
 * `30000 # five minutes` is a value plus a comment.
 */
export function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const closing = trimmed.lastIndexOf(first);
    if (closing > 0) {
      const inner = trimmed.slice(1, closing);
      return first === '"'
        ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
        : inner;
    }
  }

  const commentAt = trimmed.search(/\s#/);
  return (commentAt >= 0 ? trimmed.slice(0, commentAt) : trimmed).trim();
}

/** Quote only when leaving the value bare would change how dotenv reads it. */
export function serializeEnvValue(value: string): string {
  if (value === "") return "";
  const needsQuotes =
    /[\n\r"']/.test(value) ||
    /\s#/.test(value) ||
    value.startsWith("#") ||
    value !== value.trim();

  if (!needsQuotes) return value;

  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

export function parseEnvFile(contents: string): ParsedEnvFile {
  const lines: ParsedEnvLine[] = [];
  const values: Record<string, string> = {};

  for (const raw of contents.split("\n")) {
    const match = ASSIGNMENT.exec(raw);
    if (!match || raw.trimStart().startsWith("#")) {
      lines.push({ raw });
      continue;
    }

    const [, key, rawValue] = match;
    const value = parseEnvValue(rawValue);
    lines.push({ raw, key, value });
    // A later assignment wins, matching how dotenv itself resolves duplicates.
    values[key] = value;
  }

  return { lines, values };
}

/**
 * Patch `updates` into a parsed file and return the new file contents.
 *
 * Existing keys are rewritten in place so their surrounding comments keep
 * pointing at the right thing. Unknown keys are appended under a single
 * generated heading. A key assigned more than once is rewritten at its *last*
 * assignment (the one dotenv actually honours) and blanked at the earlier ones,
 * so the file cannot end up disagreeing with itself.
 */
export function applyEnvUpdates(
  parsed: ParsedEnvFile,
  updates: Record<string, string>
): string {
  const lines = parsed.lines.map((line) => ({ ...line }));
  const pending = new Set(Object.keys(updates));

  const lastIndexByKey = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.key) lastIndexByKey.set(line.key, index);
  });

  lines.forEach((line, index) => {
    if (!line.key || !pending.has(line.key)) return;
    if (lastIndexByKey.get(line.key) !== index) {
      // A shadowed duplicate. Comment it out rather than leaving a stale value
      // in the file for someone to read and be misled by later.
      lines[index] = { raw: `# ${line.raw.trim()}   # superseded by the value below` };
      return;
    }
    const value = updates[line.key];
    lines[index] = {
      raw: `${line.key}=${serializeEnvValue(value)}`,
      key: line.key,
      value,
    };
    pending.delete(line.key);
  });

  if (pending.size > 0) {
    if (lines.length > 0 && lines[lines.length - 1].raw.trim() !== "") {
      lines.push({ raw: "" });
    }
    lines.push({ raw: "# Added by the Setup Console" });
    for (const key of Object.keys(updates)) {
      if (!pending.has(key)) continue;
      const value = updates[key];
      lines.push({ raw: `${key}=${serializeEnvValue(value)}`, key, value });
    }
    lines.push({ raw: "" });
  }

  return lines.map((line) => line.raw).join("\n");
}

export async function readEnvFile(): Promise<ParsedEnvFile & { exists: boolean }> {
  const filePath = getEnvFilePath();
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return { ...parseEnvFile(contents), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], values: {}, exists: false };
    }
    throw error;
  }
}

/**
 * Write updates to `.env`.
 *
 * The write is atomic (temp file plus rename) because a torn `.env` is a
 * uniquely bad failure: the app would boot with half its configuration and the
 * cause would not be obvious. A timestamped backup of the previous contents is
 * kept next to it for the same reason.
 */
export async function writeEnvUpdates(
  updates: Record<string, string>
): Promise<{ filePath: string; backupPath: string | null; created: boolean }> {
  const filePath = getEnvFilePath();
  const parsed = await readEnvFile();

  const seed = parsed.exists
    ? parsed
    : parseEnvFile(
        [
          "# OpenReply environment",
          "# Written by the Setup Console. Safe to edit by hand.",
          "",
        ].join("\n")
      );

  const next = applyEnvUpdates(seed, updates);

  let backupPath: string | null = null;
  if (parsed.exists) {
    backupPath = `${filePath}.backup`;
    await fs.copyFile(filePath, backupPath);
  }

  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, next, { mode: 0o600 });
  await fs.rename(tempPath, filePath);

  // Keep the in-process environment consistent with what was just written, so
  // the readiness checks on the next request test the new values rather than
  // the ones this server booted with.
  for (const [key, value] of Object.entries(updates)) {
    if (value === "") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return { filePath, backupPath, created: !parsed.exists };
}

export function generateSecret(kind: GeneratorKind): string {
  switch (kind) {
    case "base64_32":
      return randomBytes(32).toString("base64");
    case "hex_32":
      return randomBytes(32).toString("hex");
    case "hex_16":
      return randomBytes(16).toString("hex");
  }
}

/**
 * What the console shows in place of a secret. Enough of a fingerprint to tell
 * two values apart or spot a truncated paste, without putting the secret itself
 * into a response body.
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 3)}${"•".repeat(Math.min(24, value.length - 6))}${value.slice(-3)}`;
}
