import { describe, expect, it } from "vitest";
import {
  applyEnvUpdates,
  generateSecret,
  maskSecret,
  parseEnvFile,
  parseEnvValue,
  serializeEnvValue,
} from "@/lib/setup/env-file";

describe("parseEnvValue", () => {
  it("reads a bare value", () => {
    expect(parseEnvValue("hello")).toBe("hello");
  });

  it("keeps interior spaces in an unquoted value", () => {
    // EMAIL_FROM ships unquoted in .env.example and contains spaces.
    expect(parseEnvValue("OpenReply <login@example.com>")).toBe(
      "OpenReply <login@example.com>"
    );
  });

  it("strips a trailing comment only when whitespace precedes the hash", () => {
    expect(parseEnvValue("300000 # five minutes")).toBe("300000");
    expect(parseEnvValue("re_ab#cd")).toBe("re_ab#cd");
  });

  it("unwraps double quotes and unescapes", () => {
    expect(parseEnvValue('"line\\nbreak"')).toBe("line\nbreak");
    expect(parseEnvValue('"say \\"hi\\""')).toBe('say "hi"');
  });

  it("unwraps single quotes literally", () => {
    expect(parseEnvValue("'raw\\nvalue'")).toBe("raw\\nvalue");
  });

  it("treats an empty assignment as empty", () => {
    expect(parseEnvValue("")).toBe("");
    expect(parseEnvValue("   ")).toBe("");
  });
});

describe("serializeEnvValue", () => {
  it("leaves simple values bare", () => {
    expect(serializeEnvValue("redis://localhost:6379")).toBe(
      "redis://localhost:6379"
    );
  });

  it("leaves interior spaces bare", () => {
    expect(serializeEnvValue("OpenReply <login@x.com>")).toBe(
      "OpenReply <login@x.com>"
    );
  });

  it("quotes values that would otherwise pick up a comment", () => {
    expect(serializeEnvValue("30 # nope")).toBe('"30 # nope"');
  });

  it("quotes and escapes newlines and quotes", () => {
    expect(serializeEnvValue('a"b')).toBe('"a\\"b"');
    expect(serializeEnvValue("a\nb")).toBe('"a\\nb"');
  });

  it("round-trips everything it quotes", () => {
    for (const value of ['a"b', "a\nb", "30 # nope", " padded ", "#leading"]) {
      expect(parseEnvValue(serializeEnvValue(value))).toBe(value);
    }
  });
});

describe("parseEnvFile", () => {
  it("records assignments and preserves every line", () => {
    const source = ["# comment", "A=1", "", "B=two", "not an assignment"].join("\n");
    const parsed = parseEnvFile(source);

    expect(parsed.values).toEqual({ A: "1", B: "two" });
    expect(parsed.lines.map((line) => line.raw).join("\n")).toBe(source);
  });

  it("ignores an assignment inside a comment", () => {
    const parsed = parseEnvFile("# A=1\nB=2");
    expect(parsed.values).toEqual({ B: "2" });
  });

  it("honours the last assignment when a key repeats, as dotenv does", () => {
    expect(parseEnvFile("A=first\nA=second").values).toEqual({ A: "second" });
  });

  it("supports the export prefix", () => {
    expect(parseEnvFile("export A=1").values).toEqual({ A: "1" });
  });
});

describe("applyEnvUpdates", () => {
  it("rewrites a value in place, leaving comments and neighbours untouched", () => {
    const parsed = parseEnvFile(
      ["# App", "NEXTAUTH_URL=http://localhost:3000", "OTHER=keep"].join("\n")
    );

    expect(applyEnvUpdates(parsed, { NEXTAUTH_URL: "https://live.example" })).toBe(
      ["# App", "NEXTAUTH_URL=https://live.example", "OTHER=keep"].join("\n")
    );
  });

  it("is byte-identical when nothing is updated", () => {
    const source = ["# heading", "A=1", "", "B=2", ""].join("\n");
    expect(applyEnvUpdates(parseEnvFile(source), {})).toBe(source);
  });

  it("never touches keys it was not asked to change", () => {
    const source = ["A=1", "B=2", "C=3"].join("\n");
    const result = applyEnvUpdates(parseEnvFile(source), { B: "changed" });
    expect(result).toBe(["A=1", "B=changed", "C=3"].join("\n"));
  });

  it("appends unknown keys under a generated heading", () => {
    const result = applyEnvUpdates(parseEnvFile("A=1"), { NEW_KEY: "value" });
    expect(result).toContain("# Added by the Setup Console");
    expect(result).toContain("NEW_KEY=value");
    expect(result.startsWith("A=1")).toBe(true);
  });

  it("updates the winning duplicate and comments out the shadowed one", () => {
    const result = applyEnvUpdates(parseEnvFile("A=first\nA=second"), { A: "third" });
    const lines = result.split("\n");

    expect(lines[0].startsWith("#")).toBe(true);
    expect(lines[0]).toContain("A=first");
    expect(lines[1]).toBe("A=third");
    // The file must now agree with itself.
    expect(parseEnvFile(result).values.A).toBe("third");
  });

  it("writes an empty value rather than dropping the key", () => {
    expect(applyEnvUpdates(parseEnvFile("A=1"), { A: "" })).toBe("A=");
  });

  it("quotes an appended value that needs it", () => {
    const result = applyEnvUpdates(parseEnvFile(""), { A: "x # y" });
    expect(result).toContain('A="x # y"');
    expect(parseEnvFile(result).values.A).toBe("x # y");
  });
});

describe("generateSecret", () => {
  it("produces a 64-character hex string for ENCRYPTION_KEY's shape", () => {
    const value = generateSecret("hex_32");
    expect(value).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces 32 hex characters for hex_16", () => {
    expect(generateSecret("hex_16")).toMatch(/^[a-f0-9]{32}$/);
  });

  it("produces decodable base64 of 32 bytes", () => {
    expect(Buffer.from(generateSecret("base64_32"), "base64")).toHaveLength(32);
  });

  it("does not repeat itself", () => {
    expect(generateSecret("hex_32")).not.toBe(generateSecret("hex_32"));
  });
});

describe("maskSecret", () => {
  it("shows only the ends of a long value", () => {
    const masked = maskSecret("abcdefghijklmnop");
    expect(masked.startsWith("abc")).toBe(true);
    expect(masked.endsWith("nop")).toBe(true);
    expect(masked).not.toContain("defghijk");
  });

  it("reveals nothing at all for a short value", () => {
    expect(maskSecret("short")).toBe("•••••");
  });

  it("stays empty for an unset value", () => {
    expect(maskSecret("")).toBe("");
  });
});
