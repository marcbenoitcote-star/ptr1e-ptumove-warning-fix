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

class CharacterSheet {
  constructor(actor) {
    this.actor = actor;
    this.options = { editable: true };
    this.originalActivateCalls = 0;
  }

  activateListeners() {
    this.originalActivateCalls += 1;
  }
}

class TestRuleElement {
  constructor(source, item, options = {}) {
    this.source = source;
    this.item = item;
    this.sourceIndex = options.sourceIndex;
  }
}

class RuleElements {
  static custom = {};
  static builtin = {
    ActiveEffectLike: TestRuleElement,
    ApplyEffect: TestRuleElement,
    GrantItem: TestRuleElement,
    RollOption: TestRuleElement
  };
  static originalCalls = 0;

  static fromOwnedItem(item, options = {}) {
    this.originalCalls += 1;
    const rules = [];
    for (const [sourceIndex, source] of item.system.rules?.entries() ?? []) {
      const RuleElementDocument = this.custom[source.key] ?? this.builtin[source.key];
      if (!RuleElementDocument) continue;
      rules.push(new RuleElementDocument(source, item, { ...options, sourceIndex }));
    }
    return rules;
  }
}

const actor = {
  id: "ACTOR1",
  uuid: "Actor.ACTOR1",
  name: "Actor Test",
  type: "character",
  system: {
    modifiers: {
      baseStats: {
        speed: { mod: 0 }
      }
    }
  },
  flags: { ptu: { rulesSelections: {} } },
  items: { contents: [] },
  attacks: new Map()
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
const makeRuleItem = (id, name, rules, flags = {}) => ({
  id,
  uuid: `Actor.ACTOR1.Item.${id}`,
  name,
  type: "effect",
  actor,
  parent: actor,
  flags,
  system: { rules },
  _source: { system: { rules } }
});

const validRuleItem = makeRuleItem("VALIDRULE", "Regle valide", [{
  key: "ActiveEffectLike",
  mode: "add",
  path: "system.modifiers.baseStats.speed.mod",
  value: 1
}]);
const unresolvedRuleItem = makeRuleItem("UNRESOLVED", "Choix manquant", [{
  key: "ActiveEffectLike",
  mode: "add",
  path: "system.modifiers.baseStats.{item|flags.ptu.rulesSelections.ace-trainer}.mod",
  value: 1
}]);
const injectedRuleItem = makeRuleItem("INJECTED", "Choix valide", [{
  key: "ActiveEffectLike",
  mode: "add",
  path: "system.modifiers.baseStats.{item|flags.ptu.rulesSelections.ace-trainer}.mod",
  value: 1
}], { ptu: { rulesSelections: { "ace-trainer": "speed" } } });
const incompleteRuleItem = makeRuleItem("INCOMPLETE", "Regle incomplete", [{
  key: "ActiveEffectLike",
  mode: "add",
  value: ""
}]);
const invalidPathRuleItem = makeRuleItem("BADPATH", "Chemin absent", [{
  key: "ActiveEffectLike",
  mode: "add",
  path: "system.chemin.qui.nexiste.pas",
  value: 1
}]);
const validApplyEffectItem = makeRuleItem("VALIDAPPLY", "ApplyEffect valide", [{
  key: "ApplyEffect",
  uuid: "Item.EFFECT1",
  selectors: ["attack"]
}]);
const invalidApplyEffectItem = makeRuleItem("BADAPPLY", "ApplyEffect sans selector", [{
  key: "ApplyEffect",
  uuid: "Item.EFFECT1",
  selectors: [undefined]
}]);
const validRollOptionItem = makeRuleItem("VALIDROLL", "RollOption valide", [{
  key: "RollOption",
  option: "weapon:fire"
}]);
const invalidRollOptionItem = makeRuleItem("BADROLL", "RollOption vide", [{
  key: "RollOption",
  domain: "all",
  option: "!!!"
}]);
const validGrantItemItem = makeRuleItem("VALIDGRANT", "GrantItem valide", [{
  key: "GrantItem",
  uuid: "Item.GRANTED1",
  reevaluateOnUpdate: true,
  predicate: ["feature:enabled"]
}]);
const invalidGrantItemItem = makeRuleItem("BADGRANT", "GrantItem sans predicate", [{
  key: "GrantItem",
  uuid: "Item.GRANTED1",
  reevaluateOnUpdate: true,
  predicate: []
}]);
actor.items.contents.push(
  validMove,
  invalidFrequencyMove,
  invalidDamageBaseMove,
  validRuleItem,
  unresolvedRuleItem,
  injectedRuleItem,
  incompleteRuleItem,
  invalidPathRuleItem,
  validApplyEffectItem,
  invalidApplyEffectItem,
  validRollOptionItem,
  invalidRollOptionItem,
  validGrantItemItem,
  invalidGrantItemItem
);

const moduleRecord = {};
const context = vm.createContext({
  CONFIG: {
    PTU: {
      Actor: { sheetClasses: { character: CharacterSheet } },
      Item: { documentClasses: { move: Move } },
      rule: { elements: RuleElements },
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

assert.equal(moduleRecord.api.version, "0.5.0");
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
assert.equal(dataIssues.some((row) => row.issue === "AE_LIKE_UNRESOLVED_INJECTION" && row.itemUuid.endsWith("UNRESOLVED")), true);
assert.equal(dataIssues.some((row) => row.issue === "AE_LIKE_MISSING_PATH" && row.itemUuid.endsWith("INCOMPLETE")), true);
assert.equal(dataIssues.some((row) => row.issue === "AE_LIKE_EMPTY_VALUE" && row.itemUuid.endsWith("INCOMPLETE")), true);
assert.equal(dataIssues.some((row) => row.issue === "AE_LIKE_INVALID_PATH" && row.itemUuid.endsWith("BADPATH")), true);
assert.equal(dataIssues.some((row) => row.issue === "APPLY_EFFECT_MISSING_SELECTORS" && row.itemUuid.endsWith("BADAPPLY")), true);
assert.equal(dataIssues.some((row) => row.issue === "APPLY_EFFECT_INVALID_SELECTOR" && row.itemUuid.endsWith("BADAPPLY")), true);
assert.equal(dataIssues.some((row) => row.issue === "ROLL_OPTION_EMPTY_RESOLVED_OPTION" && row.itemUuid.endsWith("BADROLL")), true);
assert.equal(dataIssues.some((row) => row.issue === "GRANT_ITEM_REEVALUATE_WITHOUT_PREDICATE" && row.itemUuid.endsWith("BADGRANT")), true);

const originalCallsBeforeValidRule = RuleElements.originalCalls;
assert.equal(RuleElements.fromOwnedItem(validRuleItem).length, 1);
assert.equal(RuleElements.originalCalls, originalCallsBeforeValidRule + 1, "Une regle valide conserve la methode PTR originale");
assert.equal(RuleElements.fromOwnedItem(unresolvedRuleItem).length, 0, "Une injection absente est gardee inactive sans construire la regle");
const injectedRules = RuleElements.fromOwnedItem(injectedRuleItem);
assert.equal(injectedRules.length, 1);
assert.equal(injectedRules[0].source.path, "system.modifiers.baseStats.speed.mod", "Un chemin injectable valide est resolu avant PTR");
assert.equal(RuleElements.fromOwnedItem(incompleteRuleItem).length, 0, "Une regle incomplete ne declenche plus l'erreur DataModel repetee");
assert.equal(RuleElements.fromOwnedItem(invalidPathRuleItem).length, 0, "Un chemin Actor invalide reste inactif sans spam");
assert.equal(RuleElements.fromOwnedItem(validApplyEffectItem).length, 1, "Un ApplyEffect valide conserve le comportement PTR");
assert.equal(RuleElements.fromOwnedItem(invalidApplyEffectItem).length, 0, "Un ApplyEffect sans selector est garde inactif");
assert.equal(RuleElements.fromOwnedItem(validRollOptionItem).length, 1, "Un RollOption valide conserve le comportement PTR");
assert.equal(RuleElements.fromOwnedItem(invalidRollOptionItem).length, 0, "Un RollOption vide est garde inactif");
assert.equal(RuleElements.fromOwnedItem(validGrantItemItem).length, 1, "Un GrantItem valide conserve le comportement PTR");
assert.equal(RuleElements.fromOwnedItem(invalidGrantItemItem).length, 0, "Un GrantItem reevalue sans predicate est garde inactif");

let struggleUseCalls = 0;
const temporaryStruggle = new Move({
  id: "STRUGGLE1",
  uuid: "Actor.ACTOR1.Item.STRUGGLE1",
  name: "Struggle (Normal)",
  type: "move",
  system: {
    isStruggle: true,
    category: "Physical",
    type: "Normal",
    damageBase: 4,
    frequency: { type: "at-will", max: 0 },
    rules: []
  }
}, actor);
temporaryStruggle.use = async () => { struggleUseCalls += 1; };
actor.attacks.set("STRUGGLE1", temporaryStruggle);
const clickHandlers = [];
const sheet = new CharacterSheet(actor);
sheet.activateListeners({
  find(selector) {
    assert.equal(selector, ".rollable.move");
    return { click(handler) { clickHandlers.push(handler); } };
  }
});
assert.equal(sheet.originalActivateCalls, 1);
assert.equal(clickHandlers.length, 1);
let prevented = false;
let stopped = false;
await clickHandlers[0]({
  currentTarget: { closest: () => ({ dataset: { itemId: "STRUGGLE1" } }) },
  preventDefault() { prevented = true; },
  stopImmediatePropagation() { stopped = true; }
});
assert.equal(struggleUseCalls, 1, "Le Struggle temporaire de la fiche Dresseur est lance");
assert.equal(prevented, true);
assert.equal(stopped, true);
assert.equal(moduleRecord.api.reportStruggleUses()[0].actorUuid, "Actor.ACTOR1");

actor.attacks.set("VALID1", validMove);
let normalMoveUseCalls = 0;
validMove.use = async () => { normalMoveUseCalls += 1; };
await clickHandlers[0]({
  currentTarget: { closest: () => ({ dataset: { itemId: "VALID1" } }) },
  preventDefault() { throw new Error("Le correctif Struggle ne doit pas intercepter un Move normal"); },
  stopImmediatePropagation() { throw new Error("Le correctif Struggle ne doit pas intercepter un Move normal"); }
});
assert.equal(normalMoveUseCalls, 0, "Un Move permanent n'est pas lance une seconde fois par le correctif Struggle");

const observedRuleIssues = moduleRecord.api.reportRuntimeIssues();
assert.equal(observedRuleIssues.some((row) =>
  row.issue === "AE_LIKE_UNRESOLVED_INJECTION"
  && row.actorUuid === "Actor.ACTOR1"
  && row.itemUuid.endsWith("UNRESOLVED")
), true);
assert.equal(observedRuleIssues.some((row) =>
  row.ruleKey === "ApplyEffect"
  && row.issue === "APPLY_EFFECT_MISSING_SELECTORS"
  && row.itemUuid.endsWith("BADAPPLY")
), true);
assert.equal(observedRuleIssues.some((row) =>
  row.ruleKey === "RollOption"
  && row.issue === "ROLL_OPTION_EMPTY_RESOLVED_OPTION"
  && row.itemUuid.endsWith("BADROLL")
), true);
assert.equal(observedRuleIssues.some((row) =>
  row.ruleKey === "GrantItem"
  && row.issue === "GRANT_ITEM_REEVALUATE_WITHOUT_PREDICATE"
  && row.itemUuid.endsWith("BADGRANT")
), true);

assert.equal(invalidFrequencyMove.item, invalidFrequencyMove);
assert.equal(moduleRecord.api.reportAccesses()[0].itemUuid, "Actor.ACTOR1.Item.BADFREQ");
assert.equal(messages.filter((entry) => entry[0] === "warn" && String(entry[1]).includes("Attaque autorisee")).length, 1);

console.log("runtime-smoke: OK");
