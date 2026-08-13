const MODULE_ID = "ptr1e-ptumove-warning-fix";
const MODULE_VERSION = "0.3.0";
const SUPPORTED_SYSTEM_VERSION = "4.4.3.37";
const ITEM_PATCH_FLAG = Symbol.for(`${MODULE_ID}.item-patched`);
const DAMAGE_BASE_PATCH_FLAG = Symbol.for(`${MODULE_ID}.damage-base-patched`);
const CONSUME_PATCH_FLAG = Symbol.for(`${MODULE_ID}.consume-patched`);
const COOLDOWN_PATCH_FLAG = Symbol.for(`${MODULE_ID}.cooldown-patched`);
const deprecatedAccesses = new Map();
const runtimeIssues = new Map();
const frequencyConsumeWarnings = new Set();

Hooks.once("init", () => {
  if (game.system.id !== "ptu") return;

  registerDiagnosticApi();

  if (game.system.version !== SUPPORTED_SYSTEM_VERSION) {
    console.warn(
      `${MODULE_ID} | Inactive: expected PTR ${SUPPORTED_SYSTEM_VERSION}, found ${game.system.version}.`
    );
    return;
  }

  const MoveClass = CONFIG.PTU?.Item?.documentClasses?.move;
  if (!MoveClass?.prototype) {
    console.error(`${MODULE_ID} | PTUMove class was not available during init.`);
    return;
  }

  const appliedPatches = [
    patchDeprecatedItemGetter(MoveClass),
    patchDamageBaseSentinel(MoveClass),
    patchInvalidFrequencyConsumption(MoveClass),
    patchInvalidFrequencyCooldown(MoveClass)
  ].filter(Boolean);

  if (appliedPatches.length > 0) {
    console.info(
      `${MODULE_ID} | Correctifs actifs pour PTR ${SUPPORTED_SYSTEM_VERSION}: ${appliedPatches.join(", ")}.`
    );
  }
  console.info(`${MODULE_ID} | Diagnostic command: game.modules.get("${MODULE_ID}").api.report()`);
});

function patchDeprecatedItemGetter(MoveClass) {
  if (MoveClass.prototype[ITEM_PATCH_FLAG]) return null;

  const descriptor = Object.getOwnPropertyDescriptor(MoveClass.prototype, "item");
  if (typeof descriptor?.get !== "function" || descriptor.configurable !== true) {
    console.warn(`${MODULE_ID} | PTUMove#item did not match the expected 4.4.3.37 getter; no patch was applied.`);
    return null;
  }

  Object.defineProperty(MoveClass.prototype, "item", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get() {
      recordDeprecatedAccess(this);
      return this;
    }
  });

  Object.defineProperty(MoveClass.prototype, ITEM_PATCH_FLAG, {
    configurable: true,
    value: true
  });

  return "PTUMove#item";
}

function patchDamageBaseSentinel(MoveClass) {
  if (MoveClass.prototype[DAMAGE_BASE_PATCH_FLAG]) return null;

  const descriptor = Object.getOwnPropertyDescriptor(MoveClass.prototype, "isDamaging");
  if (typeof descriptor?.get !== "function" || descriptor.configurable !== true) {
    console.warn(`${MODULE_ID} | PTUMove#isDamaging did not match PTR 4.4.3.37; DB '-' was not patched.`);
    return null;
  }

  Object.defineProperty(MoveClass.prototype, "isDamaging", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get() {
      const rawDamageBase = String(this.system?.damageBase ?? "").trim();
      if (rawDamageBase === "-") {
        recordRuntimeIssue(this, {
          issue: "INVALID_DAMAGE_BASE",
          path: "system.damageBase",
          value: rawDamageBase,
          details: "DB '-' traite comme un Move sans degats. Remplacer par '--' ou par un DB/formule valide."
        });
        return false;
      }
      return descriptor.get.call(this);
    }
  });

  Object.defineProperty(MoveClass.prototype, DAMAGE_BASE_PATCH_FLAG, {
    configurable: true,
    value: true
  });

  return "DB '-'";
}

function patchInvalidFrequencyConsumption(MoveClass) {
  if (MoveClass.prototype[CONSUME_PATCH_FLAG]) return null;

  const descriptor = findPropertyDescriptor(MoveClass.prototype, "consume");
  if (typeof descriptor?.value !== "function") {
    console.warn(`${MODULE_ID} | PTUMove#consume did not match PTR 4.4.3.37; frequency guard was not applied.`);
    return null;
  }

  const originalConsume = descriptor.value;
  Object.defineProperty(MoveClass.prototype, "consume", {
    configurable: true,
    writable: true,
    async value(...args) {
      const frequency = getFrequencyState(this);
      if (!frequency.valid) {
        const { key, record } = recordInvalidFrequency(this, "consume");
        if (!frequencyConsumeWarnings.has(key)) {
          frequencyConsumeWarnings.add(key);
          console.warn(
            `${MODULE_ID} | Attaque autorisee sans consommation de frequence pour ${record.actor} / ${record.item}.`,
            record
          );
        }
        return undefined;
      }
      return Reflect.apply(originalConsume, this, args);
    }
  });

  Object.defineProperty(MoveClass.prototype, CONSUME_PATCH_FLAG, {
    configurable: true,
    value: true
  });

  return "frequence de consume()";
}

function patchInvalidFrequencyCooldown(MoveClass) {
  if (MoveClass.prototype[COOLDOWN_PATCH_FLAG]) return null;

  const descriptor = findPropertyDescriptor(MoveClass.prototype, "onCooldown");
  if (typeof descriptor?.get !== "function" || descriptor.configurable !== true) {
    console.warn(`${MODULE_ID} | PTUMove#onCooldown did not match PTR 4.4.3.37; cooldown guard was not applied.`);
    return null;
  }

  Object.defineProperty(MoveClass.prototype, "onCooldown", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      if (!getFrequencyState(this).valid) {
        recordInvalidFrequency(this, "onCooldown");
        return false;
      }
      return descriptor.get.call(this);
    }
  });

  Object.defineProperty(MoveClass.prototype, COOLDOWN_PATCH_FLAG, {
    configurable: true,
    value: true
  });

  return "frequence de onCooldown";
}

function registerDiagnosticApi() {
  const moduleRecord = game.modules.get(MODULE_ID);
  if (!moduleRecord) {
    console.error(`${MODULE_ID} | Could not expose the diagnostic API.`);
    return;
  }

  moduleRecord.api = Object.freeze({
    version: MODULE_VERSION,
    report: reportDiagnostics,
    reportAccesses,
    reportRuntimeIssues,
    scanData,
    clearAccesses,
    clearRuntimeIssues
  });
}

function recordDeprecatedAccess(move) {
  const actor = move?.actor ?? move?.parent ?? null;
  const actorId = actor?.id ?? actor?._id ?? null;
  const actorUuid = actor?.uuid ?? (actorId ? `Actor.${actorId}` : "(actor inconnu)");
  const itemId = move?.id ?? move?._id ?? move?.realId ?? null;
  const itemUuid = move?.uuid ?? (itemId ? `${actorUuid}.Item.${itemId}` : "(move temporaire)");
  const key = `${actorUuid}|${itemUuid}`;
  const timestamp = new Date().toISOString();
  const record = deprecatedAccesses.get(key) ?? {
    actor: actor?.name ?? "(acteur inconnu)",
    actorUuid,
    actorType: actor?.type ?? "",
    item: move?.name ?? "(move inconnu)",
    itemUuid,
    itemId: itemId ?? "",
    damageBase: move?.system?.damageBase ?? "",
    count: 0,
    firstSeen: timestamp,
    lastSeen: timestamp
  };

  record.count += 1;
  record.lastSeen = timestamp;
  deprecatedAccesses.set(key, record);
}

function reportDiagnostics() {
  const accesses = buildAccessRows();
  const observedIssues = buildRuntimeIssueRows();
  const dataIssues = collectDataIssues();

  console.group(`${MODULE_ID} | Rapport complet v${MODULE_VERSION}`);
  console.warn(
    "Les acces PTUMove#item indiquent un appel obsolete du systeme, pas un Actor ou un Move corrompu."
  );
  printTable("Acces PTUMove#item agreges", accesses);
  printTable("Problemes observes pendant cette session", observedIssues);
  printTable("Problemes de donnees corrigibles", dataIssues);
  console.info(`${dataIssues.length} probleme(s) de donnees corrigible(s) detecte(s).`);
  console.groupEnd();

  return {
    version: MODULE_VERSION,
    systemVersion: game.system.version,
    accesses,
    runtimeIssues: observedIssues,
    dataIssues,
    summary: {
      uniqueDeprecatedAccesses: accesses.length,
      totalDeprecatedAccesses: accesses.reduce((total, row) => total + row.count, 0),
      runtimeIssues: observedIssues.length,
      dataIssues: dataIssues.length
    }
  };
}

function reportAccesses() {
  const rows = buildAccessRows();
  console.group(`${MODULE_ID} | Acces PTUMove#item`);
  console.warn(
    "Ce tableau est informatif : supprimer ou recreer ces Items ne corrigera pas l'appel obsolete du systeme."
  );
  printTable("Acces agreges", rows);
  console.groupEnd();
  return rows;
}

function reportRuntimeIssues() {
  const rows = buildRuntimeIssueRows();
  console.group(`${MODULE_ID} | Problemes observes pendant cette session`);
  printTable("Problemes observes", rows);
  console.info("Ces lignes indiquent exactement l'Actor, le Move, l'UUID et la valeur a corriger.");
  console.groupEnd();
  return rows;
}

function scanData() {
  const rows = collectDataIssues();
  console.group(`${MODULE_ID} | Audit des donnees PTR`);
  printTable("Problemes corrigibles", rows);
  console.info(`${rows.length} probleme(s) detecte(s). Aucun document n'a ete modifie.`);
  console.groupEnd();
  return rows;
}

function clearAccesses() {
  const removed = deprecatedAccesses.size;
  deprecatedAccesses.clear();
  console.info(`${MODULE_ID} | ${removed} acces unique(s) supprime(s) du rapport en memoire.`);
  return removed;
}

function clearRuntimeIssues() {
  const removed = runtimeIssues.size;
  runtimeIssues.clear();
  frequencyConsumeWarnings.clear();
  console.info(`${MODULE_ID} | ${removed} probleme(s) observe(s) supprime(s) du rapport en memoire.`);
  return removed;
}

function buildAccessRows() {
  return Array.from(deprecatedAccesses.values())
    .map((record) => ({ ...record }))
    .sort((left, right) =>
      right.count - left.count
      || left.actor.localeCompare(right.actor)
      || left.item.localeCompare(right.item)
    );
}

function buildRuntimeIssueRows() {
  return Array.from(runtimeIssues.values())
    .map((record) => ({ ...record }))
    .sort((left, right) =>
      right.count - left.count
      || left.issue.localeCompare(right.issue)
      || left.actor.localeCompare(right.actor)
      || left.item.localeCompare(right.item)
    );
}

function collectDataIssues() {
  const issues = [];

  for (const actor of collectActors()) {
    for (const item of collectionContents(actor?.items)) {
      const base = {
        actor: actor?.name ?? "(acteur inconnu)",
        actorUuid: actor?.uuid ?? (actor?.id ? `Actor.${actor.id}` : ""),
        item: item?.name ?? "(item inconnu)",
        itemUuid: item?.uuid ?? "",
        itemType: item?.type ?? ""
      };

      if (item?.type === "move" && String(item.system?.damageBase ?? "").trim() === "-") {
        issues.push({
          ...base,
          issue: "INVALID_DAMAGE_BASE",
          path: "system.damageBase",
          value: "-",
          details: "Remplacer '-' par '--' pour un Move sans degats, ou par un DB/formule valide."
        });
      }

      if (item?.type === "move") {
        const frequency = getFrequencyState(item);
        if (!frequency.valid) {
          issues.push({
            ...base,
            issue: "INVALID_FREQUENCY_TYPE",
            path: "system.frequency.type",
            value: frequency.displayValue,
            details: `Choisir une frequence valide: ${validFrequencyTypes().join(", ")}.`
          });
        }
      }

      const sourceRules = item?._source?.system?.rules ?? item?.system?.rules ?? [];
      if (!Array.isArray(sourceRules)) continue;

      sourceRules.forEach((rule, ruleIndex) => {
        if (rule?.key !== "ApplyEffect") return;

        const selectors = Array.isArray(rule.selectors) ? rule.selectors : [];
        const resolvedSelectors = selectors
          .map((selector) => resolveInjectedSelector(selector, actor, item, rule))
          .filter((selector) => selector.length > 0);

        if (resolvedSelectors.length === 0) {
          issues.push({
            ...base,
            issue: "APPLY_EFFECT_MISSING_SELECTORS",
            path: `system.rules.${ruleIndex}.selectors`,
            value: JSON.stringify(rule.selectors ?? null),
            details: "Ajouter au moins un selector non vide et resolvable au Rule Element ApplyEffect."
          });
        }

        if (typeof rule.uuid !== "string" || rule.uuid.trim().length === 0) {
          issues.push({
            ...base,
            issue: "APPLY_EFFECT_MISSING_UUID",
            path: `system.rules.${ruleIndex}.uuid`,
            value: String(rule.uuid ?? ""),
            details: "Ajouter l'UUID de l'Effect applique par le Rule Element ApplyEffect."
          });
        }
      });
    }
  }

  return issues.sort((left, right) =>
    left.issue.localeCompare(right.issue)
    || left.actor.localeCompare(right.actor)
    || left.item.localeCompare(right.item)
    || left.path.localeCompare(right.path)
  );
}

function recordInvalidFrequency(move, trigger) {
  const frequency = getFrequencyState(move);
  return recordRuntimeIssue(move, {
    issue: "INVALID_FREQUENCY_TYPE",
    path: "system.frequency.type",
    value: frequency.displayValue,
    trigger,
    details: `Attaque continue sans consommer la frequence. Choisir: ${validFrequencyTypes().join(", ")}.`
  });
}

function recordRuntimeIssue(move, issueData) {
  const actor = move?.actor ?? move?.parent ?? null;
  const actorId = actor?.id ?? actor?._id ?? null;
  const actorUuid = actor?.uuid ?? (actorId ? `Actor.${actorId}` : "(actor inconnu)");
  const itemId = move?.id ?? move?._id ?? move?.realId ?? null;
  const itemUuid = move?.uuid ?? (itemId ? `${actorUuid}.Item.${itemId}` : "(move temporaire)");
  const key = `${issueData.issue}|${actorUuid}|${itemUuid}|${issueData.path}|${issueData.value}`;
  const timestamp = new Date().toISOString();
  const existing = runtimeIssues.get(key);
  const record = existing ?? {
    actor: actor?.name ?? "(acteur inconnu)",
    actorUuid,
    actorType: actor?.type ?? "",
    item: move?.name ?? "(move inconnu)",
    itemUuid,
    itemId: itemId ?? "",
    itemType: move?.type ?? "move",
    damageBase: move?.system?.damageBase ?? "",
    frequencyType: move?.system?.frequency?.type ?? "",
    issue: issueData.issue,
    path: issueData.path,
    value: issueData.value,
    trigger: issueData.trigger ?? "prepareData",
    details: issueData.details,
    count: 0,
    firstSeen: timestamp,
    lastSeen: timestamp
  };

  record.count += 1;
  record.lastSeen = timestamp;
  record.trigger = issueData.trigger ?? record.trigger;
  runtimeIssues.set(key, record);
  return { key, isNew: !existing, record: { ...record } };
}

function getFrequencyState(move) {
  const type = move?.system?.frequency?.type;
  const frequencies = globalThis.CONFIG?.PTU?.data?.frequencies ?? {};
  const valid = typeof type === "string"
    && type.length > 0
    && Object.prototype.hasOwnProperty.call(frequencies, type)
    && frequencies[type] != null;

  return {
    type,
    valid,
    config: valid ? frequencies[type] : null,
    displayValue: type === undefined ? "(undefined)" : type === null ? "(null)" : String(type)
  };
}

function validFrequencyTypes() {
  return Object.keys(globalThis.CONFIG?.PTU?.data?.frequencies ?? {}).sort();
}

function findPropertyDescriptor(prototype, property) {
  let current = prototype;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function collectActors() {
  const actors = new Map();
  const addActor = (actor) => {
    if (!actor) return;
    const key = actor.uuid ?? (actor.id ? `Actor.${actor.id}` : null);
    if (key && !actors.has(key)) actors.set(key, actor);
  };

  for (const actor of collectionContents(game.actors)) addActor(actor);
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) addActor(token?.actor);

  return Array.from(actors.values());
}

function collectionContents(collection) {
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (typeof collection?.values === "function") return Array.from(collection.values());
  if (Array.isArray(collection)) return collection;
  return [];
}

function resolveInjectedSelector(selector, actor, item, rule) {
  let resolved = typeof selector === "string" ? selector.trim() : "";

  for (let pass = 0; pass < 5 && resolved.includes("{"); pass += 1) {
    let replaced = false;
    resolved = resolved.replace(/{(actor|item|rule)\|([^{}]+)}/g, (_match, scope, path) => {
      replaced = true;
      const source = scope === "actor" ? actor : scope === "item" ? item : rule;
      const value = getProperty(source, path);
      return value === undefined || value === null ? "" : String(value);
    });
    if (!replaced) break;
  }

  return resolved.trim();
}

function getProperty(object, path) {
  if (!object || typeof path !== "string") return undefined;
  if (globalThis.foundry?.utils?.getProperty) {
    return globalThis.foundry.utils.getProperty(object, path);
  }
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function printTable(label, rows) {
  console.info(`${label}: ${rows.length}`);
  if (rows.length > 0) console.table(rows);
}
