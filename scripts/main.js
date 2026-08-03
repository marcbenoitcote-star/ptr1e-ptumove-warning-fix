const MODULE_ID = "ptr1e-ptumove-warning-fix";
const MODULE_VERSION = "0.2.0";
const SUPPORTED_SYSTEM_VERSION = "4.4.3.37";
const PATCH_FLAG = Symbol.for(`${MODULE_ID}.patched`);
const deprecatedAccesses = new Map();

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

  if (MoveClass.prototype[PATCH_FLAG]) return;

  const descriptor = Object.getOwnPropertyDescriptor(MoveClass.prototype, "item");
  if (typeof descriptor?.get !== "function" || descriptor.configurable !== true) {
    console.warn(`${MODULE_ID} | PTUMove#item did not match the expected 4.4.3.37 getter; no patch was applied.`);
    return;
  }

  Object.defineProperty(MoveClass.prototype, "item", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get() {
      recordDeprecatedAccess(this);
      return this;
    }
  });

  Object.defineProperty(MoveClass.prototype, PATCH_FLAG, {
    configurable: true,
    value: true
  });

  console.info(`${MODULE_ID} | Patched PTUMove#item for PTR ${SUPPORTED_SYSTEM_VERSION}.`);
  console.info(`${MODULE_ID} | Diagnostic command: game.modules.get("${MODULE_ID}").api.report()`);
});

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
    scanData,
    clearAccesses
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
  const dataIssues = collectDataIssues();

  console.group(`${MODULE_ID} | Rapport complet v${MODULE_VERSION}`);
  console.warn(
    "Les acces PTUMove#item indiquent un appel obsolete du systeme, pas un Actor ou un Move corrompu."
  );
  printTable("Acces PTUMove#item agreges", accesses);
  printTable("Problemes de donnees corrigibles", dataIssues);
  console.info(`${dataIssues.length} probleme(s) de donnees corrigible(s) detecte(s).`);
  console.groupEnd();

  return {
    version: MODULE_VERSION,
    systemVersion: game.system.version,
    accesses,
    dataIssues,
    summary: {
      uniqueDeprecatedAccesses: accesses.length,
      totalDeprecatedAccesses: accesses.reduce((total, row) => total + row.count, 0),
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

function buildAccessRows() {
  return Array.from(deprecatedAccesses.values())
    .map((record) => ({ ...record }))
    .sort((left, right) =>
      right.count - left.count
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
