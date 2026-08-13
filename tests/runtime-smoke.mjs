import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(testDirectory, "..", "scripts", "main.js"), "utf8");
let initCallback = null;
const messages = [];

class BaseItem {
  constructor(data, actor) {
    Object.assign(this, data);
    this.actor = actor;
    this.parent = actor;
    this.flags = { ptu: { eot: 0, used: 0 } };
    this.originalConsumeCalls = 0;
  }

  get onCooldown() {
    if (!this.system.frequency?.type) return false;
    const frequency = context.CONFIG.PTU.data.frequencies[this.system.frequency.type];
    if (frequency.eot && (this.flags.ptu.eot ?? 0) > 0) return true;
    if (frequency.limited && this.flags.ptu.used >= (this.system.frequency.max ?? 1)) return true;
    return false;
  }

  async consume() {
    this.originalConsumeCalls += 1;
    const frequency = context.CONFIG.PTU.data.frequencies[this.system.frequency?.type];
    if (frequency.limited) this.flags.ptu.used += 1;
  }
}

class Move extends BaseItem {
  get item() {
    return this;
  }

  get isDamaging() {
    const raw = String(this.system.damageBase ?? "").trim();
    if (!raw || raw === "--") return false;
    return true;
  }
}

const actor = {
  id: "ACTOR1",
  uuid: "Actor.ACTOR1",
  name: "Actor Test",
  type: "character",
  items: { contents: [] }
};

const makeMove = (id, name, damageBase, frequencyType) => new Move({
  id,
  uuid: `Actor.ACTOR1.Item.${id}`,
  name,
  type: "move",
  system: {
    damageBase,
    frequency: { type: frequencyType, max: 1 },
    rules: []
  }
}, actor);

const validMove = makeMove("VALID1", "Move valide", "7", "scene");
const invalidFrequencyMove = makeMove("BADFREQ", "Move frequence invalide", "8", "scene-x2");
const invalidDamageBaseMove = makeMove("BADDB", "Move DB invalide", "-", "at-will");
actor.items.contents.push(validMove, invalidFrequencyMove, invalidDamageBaseMove);

const moduleRecord = {};
const context = vm.createContext({
  CONFIG: {
    PTU: {
      Item: { documentClasses: { move: Move } },
      data: {
        frequencies: {
          "at-will": { eot: false, limited: false },
          eot: { eot: true, limited: false },
          scene: { eot: true, limited: true },
          daily: { eot: true, limited: true },
          static: { eot: false, limited: false },
          custom: { eot: false, limited: true }
        }
      }
    }
  },
  Hooks: {
    once(hook, callback) {
      assert.equal(hook, "init");
      initCallback = callback;
    }
  },
  game: {
    system: { id: "ptu", version: "4.4.3.37" },
    modules: new Map([["ptr1e-ptumove-warning-fix", moduleRecord]]),
    actors: { contents: [actor] }
  },
  foundry: {
    utils: {
      getProperty(object, propertyPath) {
        return propertyPath.split(".").reduce((value, key) => value?.[key], object);
      }
    }
  },
  console: {
    info(...args) { messages.push(["info", ...args]); },
    warn(...args) { messages.push(["warn", ...args]); },
    error(...args) { messages.push(["error", ...args]); },
    group() {},
    groupEnd() {},
    table() {}
  },
  Date,
  Map,
  Object,
  Reflect,
  String,
  Symbol,
  Array,
  JSON,
  RegExp,
  globalThis: null
});
context.globalThis = context;

vm.runInContext(source, context, { filename: "scripts/main.js" });
assert.equal(typeof initCallback, "function");
initCallback();

assert.equal(moduleRecord.api.version, "0.3.0");
assert.equal(invalidDamageBaseMove.isDamaging, false, "DB '-' doit etre non dommageant");
assert.equal(validMove.isDamaging, true);

await validMove.consume();
assert.equal(validMove.originalConsumeCalls, 1, "Une frequence valide garde le consume PTR original");

assert.equal(invalidFrequencyMove.onCooldown, false, "Une frequence invalide ne doit pas planter le cooldown");
await invalidFrequencyMove.consume();
await invalidFrequencyMove.consume();
assert.equal(invalidFrequencyMove.originalConsumeCalls, 0, "Une frequence invalide ne doit plus lancer l'exception PTR");

const runtimeIssues = moduleRecord.api.reportRuntimeIssues();
assert.equal(runtimeIssues.some((row) =>
  row.issue === "INVALID_FREQUENCY_TYPE"
  && row.actor === "Actor Test"
  && row.item === "Move frequence invalide"
  && row.actorUuid === "Actor.ACTOR1"
  && row.itemUuid === "Actor.ACTOR1.Item.BADFREQ"
), true);
assert.equal(runtimeIssues.some((row) => row.issue === "INVALID_DAMAGE_BASE"), true);

const dataIssues = moduleRecord.api.scanData();
assert.equal(dataIssues.some((row) => row.issue === "INVALID_FREQUENCY_TYPE" && row.itemUuid.endsWith("BADFREQ")), true);
assert.equal(dataIssues.some((row) => row.issue === "INVALID_DAMAGE_BASE" && row.itemUuid.endsWith("BADDB")), true);

assert.equal(invalidFrequencyMove.item, invalidFrequencyMove);
assert.equal(moduleRecord.api.reportAccesses()[0].itemUuid, "Actor.ACTOR1.Item.BADFREQ");
assert.equal(messages.filter((entry) => entry[0] === "warn" && String(entry[1]).includes("Attaque autorisee")).length, 1);

console.log("runtime-smoke: OK");
