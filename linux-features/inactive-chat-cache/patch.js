"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const identifier = String.raw`[A-Za-z_$][\w$]*`;
// Vite/Rolldown bundles bind the TTL, retry delay and count to module constants.
const initialization = new RegExp(
  `(${identifier})=108e5,(${identifier})=15e3,(${identifier})=(\\d+),` +
  `${identifier}=class\\{params;inactiveOwnerConversationSinceById=new Map`, "g",
);
// Every bundle declares exactly one owner class; rspack/SWC inlines its constants.
const ownerClass = new RegExp(
  `(?:${identifier}=class|class ${identifier})\\{params;inactiveOwnerConversationSinceById=new Map`, "g",
);
const selector = "getInactiveOwnerConversationIdsToUnsubscribe(e){";
const unsubscribe = "async unsubscribeInactiveConversation(e){";
const quoted = "(?:\\x60resumed\\x60|\"resumed\")";

function protectDispatch(source) {
  const start = source.indexOf(unsubscribe);
  if (start < 0 || source.indexOf(unsubscribe, start + unsubscribe.length) >= 0) {
    throw new Error("Expected one inactive owner unsubscribe method");
  }
  const brace = start + unsubscribe.length - 1;
  const end = findMatchingBrace(source, brace);
  const body = source.slice(brace + 1, end);
  const guards = [...body.matchAll(new RegExp(
    "if\\((" + identifier + ")\\?\\.resumeState!==" + quoted +
    "\\|\\|!this\\.params\\.streamState\\.ownsConversationHistoryStream\\(e\\)", "g",
  ))];
  if (guards.length !== 1) throw new Error("Inactive owner unsubscribe precondition changed");
  const conversation = guards[0][1];
  const at = guards[0].index + guards[0][0].length;
  const recheck = "||this.hasActiveConversationView(e)" +
    "||this.hasOwnedStreamFollowers(e)" +
    `||this.shouldKeepConversationLoaded(${conversation})`;
  const rest = body.slice(at);
  // Both the block form `){...}` and the SWC form `)return void ...` skip dispatch.
  if (rest.startsWith(recheck + "){") || rest.startsWith(recheck + ")return")) return source;
  if (!rest.startsWith("){") && !rest.startsWith(")return")) {
    throw new Error("Unexpected inactive owner unsubscribe activity guard");
  }
  return source.slice(0, brace + 1) + body.slice(0, at) + recheck + rest + source.slice(end);
}

function maximum(context = {}) {
  const configured = context.feature?.settings?.maximumInactiveOwners;
  const value = configured === undefined ? 10 : configured;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
    throw new Error("inactive-chat-cache.maximumInactiveOwners must be an integer from 0 to 10");
  }
  return value;
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function prepare(source, limit) {
  const classes = [...source.matchAll(ownerClass)];
  if (classes.length !== 1) throw new Error("Expected one current inactive owner cache initializer");
  const classStart = classes[0].index + classes[0][0].indexOf("{");
  const classEnd = findMatchingBrace(source, classStart);
  const start = source.indexOf(selector);
  if (start < classStart || start > classEnd ||
      source.indexOf(selector, start + selector.length) >= 0) {
    throw new Error("Expected one inactive owner eviction selector");
  }
  const brace = start + selector.length - 1;
  const selectorEnd = findMatchingBrace(source, brace);
  const body = source.slice(brace + 1, selectorEnd);
  const counts = [...body.matchAll(new RegExp(`\\.length-(${identifier}|\\d+)\\)`, "g"))];
  const ttls = [...body.matchAll(new RegExp(`ttlMs:(${identifier}|108e5)\\}`, "g"))];
  if (counts.length !== 1 || ttls.length !== 1) {
    throw new Error("Inactive owner eviction safeguards or count contract changed");
  }
  const [count, ttl] = [counts[0][1], ttls[0][1]];
  const inlined = /^\d+$/.test(count);
  const initializers = [...source.matchAll(initialization)];
  let retry = "15e3";
  if (inlined) {
    if (ttl !== "108e5" || initializers.length !== 0) {
      throw new Error("Expected one current inactive owner cache initializer");
    }
  } else {
    // A named count must come from the initializer bound to this owner class.
    if (initializers.length !== 1 ||
        initializers[0].index + initializers[0][0].length !== classes[0].index + classes[0][0].length ||
        initializers[0][1] !== ttl || initializers[0][3] !== count) {
      throw new Error("Expected one current inactive owner cache initializer");
    }
    retry = initializers[0][2];
  }
  const classBody = source.slice(classStart, classEnd + 1);
  // Verify the selector's count/TTL contract and native activity exclusions.
  if (occurrences(body, `.length-${count})`) !== 1 ||
      occurrences(body, `maxInactiveOwnerThreads:${count},`) !== 1 ||
      !body.includes(`>=${ttl}`) ||
      (inlined && !classBody.includes(`now()+${retry};`)) ||
      !body.includes("this.hasActiveConversationView(") ||
      !body.includes("this.hasOwnedStreamFollowers(") ||
      !body.includes("this.shouldKeepConversationLoaded(") ||
      !body.includes("this.params.streamState.ownsConversationHistoryStream(")) {
    throw new Error("Inactive owner eviction safeguards or count contract changed");
  }
  const existing = Number(inlined ? count : initializers[0][4]);
  if (existing !== 10 && existing !== limit) {
    throw new Error("Unexpected inactive owner cache default");
  }
  const guarded = source.slice(0, classStart) + protectDispatch(classBody) + source.slice(classEnd + 1);
  if (inlined) {
    // The selector precedes the unsubscribe method, so its offsets are unchanged.
    const patchedBody = body
      .replace(`.length-${count})`, `.length-${limit})`)
      .replace(`maxInactiveOwnerThreads:${count},`, `maxInactiveOwnerThreads:${limit},`);
    return guarded.slice(0, brace + 1) + patchedBody + guarded.slice(selectorEnd);
  }
  const before = `${ttl}=108e5,${retry}=15e3,${count}=${existing},`;
  const after = `${ttl}=108e5,${retry}=15e3,${count}=${limit},`;
  const match = initializers[0];
  return guarded.slice(0, match.index) + guarded.slice(match.index).replace(before, after);
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
