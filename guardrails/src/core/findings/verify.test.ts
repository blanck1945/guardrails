import { describe, it, expect } from "vitest";
import type { Workspace } from "../workspace";
import { WorkspaceError } from "../workspace";
import { colocatedTestCandidates, extractAbsenceClaims, verifyAbsenceClaims } from "./verify";

const wsWith = (files: string[]): Workspace =>
  ({
    listFiles: async () => ({ files, truncated: false }),
  }) as unknown as Workspace;

const REPO = ["src/components/CaseFilters.tsx", "src/components/CaseFilters.test.tsx", "src/hooks/useCases.ts", "src/i18n/es.ts"];

// The exact finding from the s4 run.
const s4 = {
  file: "src/components/CaseFilters.tsx",
  title: "No colocated test for new logic in CaseFilters",
  body: "Team rule [colocated-tests] (medium; source: CLAUDE.md): every module with logic must have a colocated test. CaseFilters.tsx now contains persistence logic but no CaseFilters.test.tsx exists next to it; the PR is incomplete per the rule.",
  ruleId: "colocated-tests",
};

describe("extractAbsenceClaims", () => {
  it("extracts the object of the absence, not the subject", () => {
    expect(extractAbsenceClaims(s4.body)).toEqual(["CaseFilters.test.tsx"]);
    expect(extractAbsenceClaims("`src/a/b.ts` does not exist")).toEqual(["src/a/b.ts"]);
    expect(extractAbsenceClaims("The file src/x.json is missing")).toEqual(["src/x.json"]);
    expect(extractAbsenceClaims("missing export in foo.ts")).toEqual([]);
  });
});

describe("colocatedTestCandidates", () => {
  it("derives foo.test.ts(x) next to the file", () => {
    expect(colocatedTestCandidates("src/a/foo.ts")).toEqual(["src/a/foo.test.ts", "src/a/foo.test.tsx"]);
    expect(colocatedTestCandidates("src/a/Foo.tsx")).toEqual(["src/a/Foo.test.ts", "src/a/Foo.test.tsx"]);
    expect(colocatedTestCandidates("src/a/foo.test.ts")).toEqual([]);
    expect(colocatedTestCandidates("README.md")).toEqual([]);
  });
});

describe("verifyAbsenceClaims", () => {
  it("discards the s4 false positive (the test file exists)", async () => {
    const r = await verifyAbsenceClaims([s4], wsWith(REPO));
    expect(r.kept).toHaveLength(0);
    expect(r.contradicted).toHaveLength(1);
  });

  it("keeps the finding when the file really is absent", async () => {
    const r = await verifyAbsenceClaims([s4], wsWith(REPO.filter((f) => !f.includes(".test."))));
    expect(r.kept).toEqual([s4]);
  });

  it("keeps an absence claim that names no path", async () => {
    const f = { file: "src/hooks/useCases.ts", title: "Missing error handling", body: "There is no error handling here." };
    expect((await verifyAbsenceClaims([f], wsWith(REPO))).kept).toEqual([f]);
  });

  it("derives the colocated test path when the text names none", async () => {
    const f = { file: "src/components/CaseFilters.tsx", title: "No colocated test", body: "This component has no colocated test.", ruleId: "colocated-tests" };
    expect((await verifyAbsenceClaims([f], wsWith(REPO))).kept).toHaveLength(0);
    expect((await verifyAbsenceClaims([f], wsWith(["src/components/CaseFilters.tsx"]))).kept).toHaveLength(1);
  });

  it("does not derive a path for findings that are not about a missing test", async () => {
    const f = { file: "src/components/CaseFilters.tsx", title: "Test is flaky", body: "The colocated test uses a timer.", ruleId: "colocated-tests" };
    expect((await verifyAbsenceClaims([f], wsWith(REPO))).kept).toHaveLength(1);
  });

  it("resolves paths with a directory exactly or by suffix", async () => {
    const f = { file: "src/hooks/useCases.ts", title: "Import of a missing file", body: "src/i18n/es.ts does not exist, so the import fails." };
    expect((await verifyAbsenceClaims([f], wsWith(REPO))).kept).toHaveLength(0);
    expect((await verifyAbsenceClaims([f], wsWith(["src/hooks/useCases.ts"]))).kept).toHaveLength(1);
  });

  it("keeps everything when the file list cannot be read", async () => {
    const ws = { listFiles: async () => { throw new WorkspaceError("boom"); } } as unknown as Workspace;
    expect((await verifyAbsenceClaims([s4], ws)).kept).toEqual([s4]);
  });
});
