import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as ts from "typescript";

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

interface CallSite {
  fn: FunctionLike | undefined;
  node: ts.CallExpression;
}

function loadSource(file: string): ts.SourceFile {
  const url = new URL(file, import.meta.url);
  return ts.createSourceFile(
    url.pathname,
    readFileSync(url, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function calledName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function findCalls(src: ts.SourceFile, name: string): CallSite[] {
  const sites: CallSite[] = [];

  const visit = (node: ts.Node, fn: FunctionLike | undefined) => {
    const nextFn = isFunctionLike(node) ? node : fn;
    if (ts.isCallExpression(node) && calledName(node.expression) === name) {
      sites.push({ fn: nextFn, node });
    }
    ts.forEachChild(node, (child) => visit(child, nextFn));
  };

  visit(src, undefined);
  return sites;
}

function findIdentifiers(src: ts.SourceFile, name: string): ts.Identifier[] {
  const matches: ts.Identifier[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };

  visit(src);
  return matches;
}

function countCallsInFunction(fn: FunctionLike, name: string): number {
  let count = 0;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && calledName(node.expression) === name) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(fn, visit);
  return count;
}

function functionName(fn: FunctionLike): string | undefined {
  if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) {
    return fn.name?.text;
  }
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return undefined;
}

describe("G48 bootstrap/shutdown invariants", () => {
  it("keeps cli-actions.ts runtime ownership centralized in withRuntime", () => {
    const src = loadSource("./cli-actions.ts");
    const sites = findCalls(src, "bootstrap");

    expect(sites, "expected exactly one bootstrap() call in cli-actions.ts").toHaveLength(1);
    const site = sites[0]!;
    expect(site.fn, "bootstrap() must be inside a function").toBeDefined();
    expect(functionName(site.fn!)).toBe("withRuntime");
    expect(
      countCallsInFunction(site.fn!, "shutdown"),
      "bootstrap() in withRuntime must be paired with shutdown() in the same function",
    ).toBeGreaterThanOrEqual(1);
  });

  it("keeps cli.ts bootstrap ownership inside the serve action only", () => {
    const src = loadSource("./cli.ts");
    const sites = findCalls(src, "bootstrap");

    expect(sites, "expected exactly one bootstrap() call in cli.ts").toHaveLength(1);
    const site = sites[0]!;
    expect(site.fn, "bootstrap() must be inside the serve action").toBeDefined();

    const enclosingSlice = src.text.slice(
      Math.max(0, site.fn!.pos - 250),
      Math.min(src.text.length, site.fn!.end + 50),
    );
    expect(enclosingSlice).toMatch(/\.command\(\s*"serve\b/);
    expect(
      countCallsInFunction(site.fn!, "shutdown"),
      "serve action bootstrap() must be paired with shutdown() in the same action scope",
    ).toBeGreaterThanOrEqual(1);
  });

  it("keeps start and inspect runtime dependencies out of cli.ts", () => {
    const src = loadSource("./cli.ts");
    for (const name of ["runPlanner", "InspectorAgent", "agentId", "inspectionId", "SaivageRuntime"]) {
      expect(findIdentifiers(src, name), `unexpected ${name} reference in cli.ts`).toHaveLength(0);
    }
  });
});
