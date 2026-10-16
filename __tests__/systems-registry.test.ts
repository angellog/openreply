import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listSystems,
  systemForPath,
  SYSTEMS,
  SYSTEM_FLOWS,
  SYSTEM_IDS,
  SYSTEM_ORDER,
} from "@/lib/systems/registry";

const ROOT = path.resolve(__dirname, "..");

describe("the systems registry", () => {
  it("orders every system exactly once", () => {
    expect([...SYSTEM_ORDER].sort()).toEqual([...SYSTEM_IDS].sort());
    expect(new Set(SYSTEM_ORDER).size).toBe(SYSTEM_ORDER.length);
  });

  it("keys every definition by its own id", () => {
    for (const id of SYSTEM_IDS) {
      expect(SYSTEMS[id].id).toBe(id);
    }
  });

  // The whole value of the registry is that the nav, the map and the guide
  // read from one place. A link to a page that was never built would appear in
  // all three at once.
  it("points every page at a file that exists", () => {
    for (const system of listSystems()) {
      for (const page of system.pages) {
        const file = path.join(ROOT, "app", "(dashboard)", page.href, "page.tsx");
        expect(existsSync(file), `${system.id} → ${page.href} (${file})`).toBe(
          true
        );
      }
    }
  });

  it("never lists the same page under two systems", () => {
    const seen = new Map<string, string>();
    for (const system of listSystems()) {
      for (const page of system.pages) {
        const owner = seen.get(page.href);
        expect(owner, `${page.href} claimed by ${owner} and ${system.id}`).toBe(
          undefined
        );
        seen.set(page.href, system.id);
      }
    }
  });

  it("gives every system a primary page to open first", () => {
    for (const system of listSystems()) {
      const primary = system.pages.filter((page) => page.isPrimary);
      expect(primary.length, system.id).toBe(1);
      expect(primary[0].hiddenInNav, system.id).not.toBe(true);
    }
  });

  it("describes every system well enough to be useful", () => {
    for (const system of listSystems()) {
      expect(system.setup.length, `${system.id} setup`).toBeGreaterThan(0);
      expect(system.limits.length, `${system.id} limits`).toBeGreaterThan(0);
      expect(system.owns.models.length, `${system.id} models`).toBeGreaterThan(0);
      expect(system.owns.routes.length, `${system.id} routes`).toBeGreaterThan(0);
      expect(system.owns.libs.length, `${system.id} libs`).toBeGreaterThan(0);
      for (const page of system.pages) {
        expect(page.purpose.length, `${system.id} ${page.href}`).toBeGreaterThan(
          10
        );
      }
    }
  });

  // A setup step that sends somebody to a page must send them to a page in the
  // registry, or the guide grows links the nav cannot reach.
  it("only links setup steps to known pages", () => {
    const known = new Set(
      listSystems().flatMap((system) => system.pages.map((page) => page.href))
    );
    for (const system of listSystems()) {
      for (const step of system.setup) {
        if (!step.href) continue;
        // Anchors into the guide are the one exception: they are sections, not
        // pages, and the anchor must name a real system.
        if (step.href.startsWith("/guide#")) {
          const anchor = step.href.slice("/guide#".length);
          expect(SYSTEM_IDS as readonly string[]).toContain(anchor);
          continue;
        }
        expect(known, `${system.id} → ${step.href}`).toContain(step.href);
      }
    }
  });

  it("joins only real systems in its flows", () => {
    expect(SYSTEM_FLOWS.length).toBeGreaterThan(0);
    for (const flow of SYSTEM_FLOWS) {
      expect(SYSTEM_IDS as readonly string[]).toContain(flow.from);
      expect(SYSTEM_IDS as readonly string[]).toContain(flow.to);
      expect(flow.from).not.toBe(flow.to);
      expect(flow.mechanism.length).toBeGreaterThan(20);
    }
  });

  it("never puts a secret value in the registry", () => {
    // requiredEnv holds names so the UI can say what is missing. A value here
    // would be rendered on a page and committed to git.
    for (const system of listSystems()) {
      for (const name of system.requiredEnv) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});

describe("systemForPath", () => {
  it("finds the system a page belongs to", () => {
    expect(systemForPath("/dashboard")?.id).toBe("instagram");
    expect(systemForPath("/whatsapp")?.id).toBe("whatsapp");
    expect(systemForPath("/outreach")?.id).toBe("harvey");
    expect(systemForPath("/diagnostics")?.id).toBe("platform");
  });

  // /outreach belongs to Harvey and /outreach/resources to the resource hub.
  // A plain startsWith would hand the resource pages to Harvey and put the
  // wrong system's status banner on them.
  it("prefers the longest matching page, not the first", () => {
    expect(systemForPath("/outreach/resources")?.id).toBe("resources");
  });

  it("matches sub-paths of a page", () => {
    expect(systemForPath("/campaigns/abc123")?.id).toBe("instagram");
    expect(systemForPath("/campaigns/abc123/edit")?.id).toBe("instagram");
  });

  it("returns nothing for a path no system claims", () => {
    expect(systemForPath("/login")).toBeNull();
    expect(systemForPath("/")).toBeNull();
  });

  // "/outreachx" must not match "/outreach": the boundary is a slash.
  it("does not match a path that merely starts with the same letters", () => {
    expect(systemForPath("/outreachx")).toBeNull();
  });
});

describe("the guide", () => {
  // Adding a sixth system and forgetting to write its guide section is the
  // failure this catches: the map would show it and the guide would not.
  it("has a section for every system", () => {
    const source = readFileSync(
      path.join(ROOT, "app", "(dashboard)", "guide", "page.tsx"),
      "utf8"
    );
    for (const id of SYSTEM_IDS) {
      expect(source, `guide is missing ${id}`).toContain(`id: "${id}"`);
    }
  });
});
