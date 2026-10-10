"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const initialization = new RegExp(
  `(${identifier})=108e5,(${identifier})=15e3,(${identifier})=(\\d+),` +
  `${identifier}=class\\{params;inactiveOwnerConversationSinceById=new Map`, "g",
);
const selector = "getInactiveOwnerConversationIdsToUnsubscribe(e){";
const unsubscribe = "async unsubscribeInactiveConversation(e){";

function protectDispatch(source) {
  const start = source.indexOf(unsubscribe);
  if (start < 0 || source.indexOf(unsubscribe, start + unsubscribe.length) >= 0) {
    throw new Error("Expected one inactive owner unsubscribe method");
  }
  const brace = start + unsubscribe.length - 1;
  const end = findMatchingBrace(source, brace);
  const body = source.slice(brace + 1, end);
  const guards = [...body.matchAll(new RegExp(
    "if\\((" + identifier + ")\\?\\.resumeState!==`resumed`\\|\\|!this\\.params\\.streamState\\.ownsConversationHistoryStream\\(e\\)", "g",
  ))];
  if (guards.length !== 1) throw new Error("Inactive owner unsubscribe precondition changed");
  const conversation = guards[0][1];
  const prefix = guards[0][0];
  const original = prefix + "){";
  const guarded = prefix + "||this.hasActiveConversationView(e)" +
    "||this.hasOwnedStreamFollowers(e)" +
    `||this.shouldKeepConversationLoaded(${conversation})){`;
  if (body.includes(guarded)) return source;
  if (!body.includes(original)) throw new Error("Unexpected inactive owner unsubscribe activity guard");
  return source.slice(0, brace + 1) + body.replace(original, guarded) + source.slice(end);
}

function maximum(context = {}) {
  const configured = context.feature?.settings?.maximumInactiveOwners;
  const value = configured === undefined ? 10 : configured;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
    throw new Error("inactive-chat-cache.maximumInactiveOwners must be an integer from 0 to 10");
  }
  return value;
}

function prepare(source, limit) {
  const matches = [...source.matchAll(initialization)];
  if (matches.length !== 1) throw new Error("Expected one current inactive owner cache initializer");
  const match = matches[0];
  const [ttl, retry, count] = match.slice(1, 4);
  const start = source.indexOf(selector, match.index);
  if (start < 0 || source.indexOf(selector, start + selector.length) >= 0) {
    throw new Error("Expected one inactive owner eviction selector");
  }
  const brace = start + selector.length - 1;
  const body = source.slice(brace + 1, findMatchingBrace(source, brace));
  // Verify that this initializer belongs to the selector's count/TTL contract.
  if (!body.includes(`.length-${count}`) ||
      !body.includes(`maxInactiveOwnerThreads:${count}`) ||
      !body.includes(`ttlMs:${ttl}`) ||
      !body.includes("this.hasActiveConversationView(") ||
      !body.includes("this.hasOwnedStreamFollowers(") ||
      !body.includes("this.shouldKeepConversationLoaded(") ||
      !body.includes("this.params.streamState.ownsConversationHistoryStream(")) {
    throw new Error("Inactive owner eviction safeguards or count contract changed");
  }
  const existing = Number(match[4]);
  if (existing !== 10 && existing !== limit) {
    throw new Error("Unexpected inactive owner cache default");
  }
  const before = `${ttl}=108e5,${retry}=15e3,${count}=${existing},`;
  const after = `${ttl}=108e5,${retry}=15e3,${count}=${limit},`;
  const classStart = match.index + match[0].indexOf("class{");
  const classEnd = findMatchingBrace(source, classStart + "class".length);
  const guarded = source.slice(0, classStart) +
    protectDispatch(source.slice(classStart, classEnd + 1)) + source.slice(classEnd + 1);
  return guarded.slice(0, match.index) +
    guarded.slice(match.index).replace(before, after);
}

function scopeMaximum(context = {}) {
  const configured = context.feature?.settings?.maximumRetainedScopes;
  const value = configured === undefined ? 20 : configured;
  if (!Number.isSafeInteger(value) || value < 0 || value > 20) {
    throw new Error("inactive-chat-cache.maximumRetainedScopes must be an integer from 0 to 20");
  }
  return value;
}

function prepareScopes(source, limit) {
  // Keep the native LRU and its mountedCount exclusion. Only its capacity changes.
  for (const name of ["ThreadScope", "RouteScope"]) {
    const anchor = new RegExp(
      `(${identifier}\\(\\x60${name}\\x60,\\{key:[^;{}]+?,parent:${identifier},retain:\\{max:)(\\d+)(\\}\\}\\))`, "g",
    );
    const matches = [...source.matchAll(anchor)];
    if (matches.length !== 1) throw new Error(`Expected one native ${name} retained cache`);
    const count = Number(matches[0][2]);
    if (count !== 20 && count !== limit) throw new Error(`Unexpected ${name} capacity`);
    source = source.replace(anchor, (_, before, value, after) => before + limit + after);
  }
  return source;
}

function apply(extractedDir, context = {}) {
  const limit = maximum(context);
  const scopeLimit = scopeMaximum(context);
  const targets = [];
  for (const directory of [".vite/build", "webview/assets"]) {
    const candidates = fs.readdirSync(path.join(extractedDir, directory))
      .filter(name => name.endsWith(".js"))
      .map(name => path.join(extractedDir, directory, name))
      .map(file => ({ file, source: fs.readFileSync(file, "utf8") }))
      .filter(record => record.source.includes(selector));
    if (candidates.length !== 1) {
      throw new Error(`Expected one inactive owner bundle in ${directory}`);
    }
    const patched = prepare(candidates[0].source, limit);
    targets.push({ ...candidates[0], patched: directory === "webview/assets"
      ? prepareScopes(patched, scopeLimit) : patched });
  }
  // Qualify both bundles before writing either. Any failure aborts the build.
  let changed = 0;
  for (const target of targets) {
    if (target.source !== target.patched) {
      fs.writeFileSync(target.file, target.patched);
      changed++;
    }
  }
  return { matched: targets.length, changed, maximumInactiveOwners: limit };
}

module.exports = {
  maximum, prepare, protectDispatch, scopeMaximum, prepareScopes, apply,
  descriptors: [{
    id: "owner-count", phase: "extracted-app:pre-webview", order: 20950,
    ciPolicy: "opt-in", apply,
    status: result => result.changed ? "applied" : "already-applied",
  }],
};
