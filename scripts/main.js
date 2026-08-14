const MODULE_ID = "ptr1e-ptumove-warning-fix";
const MODULE_VERSION = "0.5.0";
const SUPPORTED_SYSTEM_VERSION = "4.4.3.37";
const ITEM_PATCH_FLAG = Symbol.for(`${MODULE_ID}.item-patched`);
const DAMAGE_BASE_PATCH_FLAG = Symbol.for(`${MODULE_ID}.damage-base-patched`);
const CONSUME_PATCH_FLAG = Symbol.for(`${MODULE_ID}.consume-patched`);
const COOLDOWN_PATCH_FLAG = Symbol.for(`${MODULE_ID}.cooldown-patched`);
const STRUGGLE_SHEET_PATCH_FLAG = Symbol.for(`${MODULE_ID}.struggle-sheet-patched`);
const RULE_ELEMENTS_PATCH_FLAG = Symbol.for(`${MODULE_ID}.rule-elements-patched`);
const deprecatedAccesses = new Map();
const runtimeIssues = new Map();
const struggleUses = new Map();
const frequencyConsumeWarnings = new Set();
const AE_LIKE_MODES = new Set(["multiply", "add", "subtract", "remove", "downgrade", "upgrade", "override"]);
const GRANT_ITEM_OPERATIONS = new Set(["add", "subtract", "remove", "multiply", "override", "upgrade", "downgrade"]);
const ROLL_OPTION_DOMAIN_PATTERN = /^[-a-z0-9]+$/;

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
    patchInvalidFrequencyCooldown(MoveClass),
    patchCharacterStruggleUse(CONFIG.PTU?.Actor?.sheetClasses?.character),
    patchInvalidRuleElements(CONFIG.PTU?.rule?.elements)
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

function patchCharacterStruggleUse(CharacterSheetClass) {
  if (!CharacterSheetClass?.prototype || CharacterSheetClass.prototype[STRUGGLE_SHEET_PATCH_FLAG]) return null;

  const descriptor = findPropertyDescriptor(CharacterSheetClass.prototype, "activateListeners");
  if (typeof descriptor?.value !== "function") {
    console.warn(`${MODULE_ID} | Character sheet listeners did not match PTR 4.4.3.37; Struggle was not patched.`);
    return null;
  }

  const originalActivateListeners = descriptor.value;
  Object.defineProperty(CharacterSheetClass.prototype, "activateListeners", {
    configurable: true,
    writable: true,
    value(html) {
      const result = Reflect.apply(originalActivateListeners, this, [html]);
      if (!this.options?.editable) return result;

      const rollableMoves = html?.find?.(".rollable.move");
      if (typeof rollableMoves?.click !== "function") return result;

      rollableMoves.click(async (event) => {
        const itemElement = event?.currentTarget?.closest?.("li.item");
        const attackId = itemElement?.dataset?.itemId;
        if (!attackId) return;

        const move = this.actor?.attacks?.get?.(attackId);
        if (!move?.system?.isStruggle) return;

        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        recordStruggleUse(move);
        return move.use?.({ event });
      });

      return result;
    }
  });

  Object.defineProperty(CharacterSheetClass.prototype, STRUGGLE_SHEET_PATCH_FLAG, {
    configurable: true,
    value: true
  });

  return "Struggle de la fiche Dresseur";
}

function patchInvalidRuleElements(RuleElements) {
  if (!RuleElements || RuleElements[RULE_ELEMENTS_PATCH_FLAG]) return null;

  const descriptor = Object.getOwnPropertyDescriptor(RuleElements, "fromOwnedItem");
  if (typeof descriptor?.value !== "function" || descriptor.configurable !== true) {
    console.warn(`${MODULE_ID} | RuleElements.fromOwnedItem did not match PTR 4.4.3.37; invalid rules were not patched.`);
    return null;
  }

  const originalFromOwnedItem = descriptor.value;
  Object.defineProperty(RuleElements, "fromOwnedItem", {
    configurable: true,
    writable: true,
    value(item, options = {}) {
      const entries = Array.from(item?.system?.rules?.entries?.() ?? []);
      const analyses = new Map();
      let requiresFiltering = false;

      for (const [sourceIndex, source] of entries) {
        const analysis = analyzeRuleElementSource(source, item?.actor ?? item?.parent, item);
        if (!analysis) continue;
        analyses.set(sourceIndex, analysis);
        if (analysis.problems.length > 0 || analysis.source !== source) requiresFiltering = true;
      }

      if (!requiresFiltering) {
        return Reflect.apply(originalFromOwnedItem, this, [item, options]);
      }

      const rules = [];
      for (const [sourceIndex, originalSource] of entries) {
        if (typeof originalSource?.key !== "string") {
          console.error(`PTU | RuleElements | Invalid rule key: ${originalSource?.key} on item ${item.name} (${item.uuid})`);
          continue;
        }

        const analysis = analyses.get(sourceIndex);
        if (analysis?.problems.length > 0) {
          for (const problem of analysis.problems) {
            recordRuleElementIssue(item, sourceIndex, originalSource.key, problem);
          }
          continue;
        }

        const source = analysis?.source ?? originalSource;
        const RuleElementDocument = this.custom[source.key] ?? this.builtin[source.key];
        if (RuleElementDocument) {
          const rule = (() => {
            try {
              return new RuleElementDocument(source, item, { ...(options ?? {}), sourceIndex });
            } catch (error) {
              if (!options.suppressWarnings) {
                console.warn(`PTU | RuleElements | Error creating rule element: ${source.key} on item ${item.name} (${item.uuid})`, error);
              }
              return null;
            }
          })();
          if (rule) rules.push(rule);
        } else {
          console.warn(`PTU | RuleElements | Unrecognized rule element: ${source.key} on item ${item.name} (${item.uuid})`);
        }
      }
      return rules;
    }
  });

  Object.defineProperty(RuleElements, RULE_ELEMENTS_PATCH_FLAG, {
    configurable: true,
    value: true
  });

  return "Rule Elements invalides";
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
    reportStruggleUses,
    reportRuntimeIssues,
    scanData,
    clearAccesses,
    clearStruggleUses,
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

function recordStruggleUse(move) {
  const actor = move?.actor ?? move?.parent ?? null;
  const actorId = actor?.id ?? actor?._id ?? null;
  const actorUuid = actor?.uuid ?? (actorId ? `Actor.${actorId}` : "(actor inconnu)");
  const itemId = move?.id ?? move?._id ?? move?.realId ?? null;
  const itemUuid = move?.uuid ?? (itemId ? `${actorUuid}.Item.${itemId}` : "(move temporaire)");
  const key = `${actorUuid}|${itemUuid}|${move?.name ?? "Struggle"}`;
  const timestamp = new Date().toISOString();
  const record = struggleUses.get(key) ?? {
    actor: actor?.name ?? "(acteur inconnu)",
    actorUuid,
    actorType: actor?.type ?? "",
    item: move?.name ?? "Struggle",
    itemUuid,
    itemId: itemId ?? "",
    category: move?.system?.category ?? "",
    type: move?.system?.type ?? "",
    count: 0,
    firstSeen: timestamp,
    lastSeen: timestamp
  };

  record.count += 1;
  record.lastSeen = timestamp;
  struggleUses.set(key, record);
}

function reportDiagnostics() {
  const accesses = buildAccessRows();
  const routedStruggles = buildStruggleUseRows();
  const observedIssues = buildRuntimeIssueRows();
  const dataIssues = collectDataIssues();

  console.group(`${MODULE_ID} | Rapport complet v${MODULE_VERSION}`);
  console.warn(
    "Les acces PTUMove#item indiquent un appel obsolete du systeme, pas un Actor ou un Move corrompu."
  );
  printTable("Acces PTUMove#item agreges", accesses);
  printTable("Struggles lances par la fiche Dresseur corrigee", routedStruggles);
  printTable("Problemes observes pendant cette session", observedIssues);
  printTable("Problemes de donnees corrigibles", dataIssues);
  console.info(`${dataIssues.length} probleme(s) de donnees corrigible(s) detecte(s).`);
  console.groupEnd();

  return {
    version: MODULE_VERSION,
    systemVersion: game.system.version,
    accesses,
    struggleUses: routedStruggles,
    runtimeIssues: observedIssues,
    dataIssues,
    summary: {
      uniqueDeprecatedAccesses: accesses.length,
      totalDeprecatedAccesses: accesses.reduce((total, row) => total + row.count, 0),
      struggleUses: routedStruggles.length,
      runtimeIssues: observedIssues.length,
      dataIssues: dataIssues.length
    }
  };
}

function reportStruggleUses() {
  const rows = buildStruggleUseRows();
  console.group(`${MODULE_ID} | Struggles de la fiche Dresseur`);
  printTable("Struggles lances par le correctif", rows);
  console.info("Chaque ligne confirme qu'un Struggle temporaire a ete retrouve dans actor.attacks puis lance.");
  console.groupEnd();
  return rows;
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

function clearStruggleUses() {
  const removed = struggleUses.size;
  struggleUses.clear();
  console.info(`${MODULE_ID} | ${removed} Struggle(s) unique(s) supprime(s) du rapport en memoire.`);
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

function buildStruggleUseRows() {
  return Array.from(struggleUses.values())
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
        const analysis = analyzeRuleElementSource(rule, actor, item);
        if (!analysis) return;
        for (const problem of analysis.problems) {
          issues.push({
            ...base,
            ruleKey: rule.key,
            issue: problem.issue,
            path: `system.rules.${ruleIndex}.${problem.field}`,
            value: formatDiagnosticValue(problem.value),
            details: problem.details
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

function analyzeRuleElementSource(source, actor, item) {
  switch (source?.key) {
    case "ActiveEffectLike":
      return analyzeActiveEffectLikeSource(source, actor, item);
    case "ApplyEffect":
      return analyzeApplyEffectSource(source, actor, item);
    case "GrantItem":
      return analyzeGrantItemSource(source, actor, item);
    case "RollOption":
      return analyzeRollOptionSource(source, actor, item);
    default:
      return null;
  }
}

function analyzeApplyEffectSource(source, actor, item) {
  const problems = [];
  const uuid = typeof source?.uuid === "string" ? source.uuid.trim() : "";

  if (!uuid) {
    problems.push({
      issue: "APPLY_EFFECT_MISSING_UUID",
      field: "uuid",
      value: source?.uuid,
      details: "Ajouter l'UUID de l'Effect applique par le Rule Element ApplyEffect."
    });
  } else {
    for (const missing of findUnresolvedInjections(source.uuid, actor, item, source)) {
      problems.push({
        issue: "APPLY_EFFECT_UNRESOLVED_INJECTION",
        field: "uuid",
        value: missing.token,
        details: `La propriete injectee ${missing.token} est absente; l'Effect a appliquer ne peut pas etre resolu.`
      });
    }
  }

  const selectors = Array.isArray(source?.selectors) ? source.selectors : [];
  let resolvedSelectorCount = 0;
  for (const selector of selectors) {
    if (typeof selector !== "string" || selector.trim().length === 0) {
      problems.push({
        issue: "APPLY_EFFECT_INVALID_SELECTOR",
        field: "selectors",
        value: selector,
        details: "Chaque selector ApplyEffect doit etre une chaine non vide."
      });
      continue;
    }

    const resolution = resolveInjectedString(selector, actor, item, source);
    for (const missing of resolution.unresolved) {
      problems.push({
        issue: "APPLY_EFFECT_UNRESOLVED_INJECTION",
        field: "selectors",
        value: missing.token,
        details: `La propriete injectee ${missing.token} est absente; le selector ApplyEffect reste inactif.`
      });
    }
    if (resolution.unresolved.length === 0 && resolution.value.trim().length > 0) {
      resolvedSelectorCount += 1;
    }
  }

  if (resolvedSelectorCount === 0) {
    problems.push({
      issue: "APPLY_EFFECT_MISSING_SELECTORS",
      field: "selectors",
      value: source?.selectors,
      details: "Ajouter au moins un selector non vide et resolvable au Rule Element ApplyEffect."
    });
  }

  return { source, problems: deduplicateRuleProblems(problems) };
}

function analyzeRollOptionSource(source, actor, item) {
  const problems = [];
  const domain = source?.domain === undefined
    ? "all"
    : typeof source.domain === "string" ? source.domain.trim() : "";
  if (!domain || !ROLL_OPTION_DOMAIN_PATTERN.test(domain) || !/[a-z]/.test(domain)) {
    problems.push({
      issue: "ROLL_OPTION_INVALID_DOMAIN",
      field: "domain",
      value: source?.domain,
      details: "Utiliser un domaine RollOption en minuscules contenant seulement lettres, chiffres et tirets."
    });
  }

  if (typeof source?.option !== "string" || source.option.trim().length === 0) {
    problems.push({
      issue: "ROLL_OPTION_MISSING_OPTION",
      field: "option",
      value: source?.option,
      details: "Ajouter une option RollOption non vide."
    });
  } else {
    const resolution = resolveInjectedString(source.option, actor, item, source);
    for (const missing of resolution.unresolved) {
      problems.push({
        issue: "ROLL_OPTION_UNRESOLVED_INJECTION",
        field: "option",
        value: missing.token,
        details: `La propriete injectee ${missing.token} est absente; l'option ne peut pas etre construite.`
      });
    }
    if (resolution.unresolved.length === 0 && sanitizeRollOption(resolution.value).length === 0) {
      problems.push({
        issue: "ROLL_OPTION_EMPTY_RESOLVED_OPTION",
        field: "option",
        value: source.option,
        details: "L'option devient vide apres le nettoyage PTR; utiliser lettres, chiffres, deux-points ou tirets."
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(source ?? {}, "value")
      && !["boolean", "string", "undefined"].includes(typeof source.value)) {
    problems.push({
      issue: "ROLL_OPTION_INVALID_VALUE",
      field: "value",
      value: source.value,
      details: "La valeur RollOption doit etre un booleen, une chaine, ou etre omise."
    });
  }

  if (source?.removeAfterRoll && item?.type !== "effect") {
    problems.push({
      issue: "ROLL_OPTION_INVALID_REMOVE_AFTER_ROLL",
      field: "removeAfterRoll",
      value: source.removeAfterRoll,
      details: "removeAfterRoll est permis uniquement sur un Item de type effect."
    });
  }

  return { source, problems: deduplicateRuleProblems(problems) };
}

function analyzeGrantItemSource(source, actor, item) {
  const problems = [];
  const uuid = typeof source?.uuid === "string" ? source.uuid.trim() : "";
  if (!uuid) {
    problems.push({
      issue: "GRANT_ITEM_MISSING_UUID",
      field: "uuid",
      value: source?.uuid,
      details: "Ajouter l'UUID de l'Item accorde par le Rule Element GrantItem."
    });
  } else {
    for (const missing of findUnresolvedInjections(source.uuid, actor, item, source)) {
      problems.push({
        issue: "GRANT_ITEM_UNRESOLVED_INJECTION",
        field: "uuid",
        value: missing.token,
        details: `La propriete injectee ${missing.token} est absente; l'Item a accorder ne peut pas etre resolu.`
      });
    }
  }

  if (source?.reevaluateOnUpdate === true && !hasRulePredicate(source.predicate)) {
    problems.push({
      issue: "GRANT_ITEM_REEVALUATE_WITHOUT_PREDICATE",
      field: "reevaluateOnUpdate",
      value: source.reevaluateOnUpdate,
      details: "Ajouter un predicate ou desactiver reevaluateOnUpdate. PTR refuse cette combinaison."
    });
  }

  if (source?.modifications !== undefined && !Array.isArray(source.modifications)) {
    problems.push({
      issue: "GRANT_ITEM_INVALID_MODIFICATIONS",
      field: "modifications",
      value: source.modifications,
      details: "modifications doit etre une liste de modifications structurees."
    });
  }

  for (const modification of Array.isArray(source?.modifications) ? source.modifications : []) {
    if (!modification || typeof modification !== "object") {
      problems.push({
        issue: "GRANT_ITEM_INVALID_MODIFICATION",
        field: "modifications",
        value: modification,
        details: "Chaque modification GrantItem doit etre un objet structure."
      });
      continue;
    }
    if (typeof modification.key !== "string" || modification.key.trim().length === 0) {
      problems.push({
        issue: "GRANT_ITEM_INVALID_MODIFICATION_KEY",
        field: "modifications",
        value: modification.key,
        details: "Chaque modification GrantItem doit avoir un chemin key non vide."
      });
    }
    const operation = modification.operation ?? "override";
    if (!GRANT_ITEM_OPERATIONS.has(operation)) {
      problems.push({
        issue: "GRANT_ITEM_INVALID_MODIFICATION_OPERATION",
        field: "modifications",
        value: operation,
        details: `Choisir une operation GrantItem valide: ${Array.from(GRANT_ITEM_OPERATIONS).join(", ")}.`
      });
    }
    if (modification.value !== undefined && typeof modification.value !== "string") {
      problems.push({
        issue: "GRANT_ITEM_INVALID_MODIFICATION_VALUE",
        field: "modifications",
        value: modification.value,
        details: "La valeur structuree d'une modification GrantItem doit etre une chaine."
      });
    }
  }

  return { source, problems: deduplicateRuleProblems(problems) };
}

function hasRulePredicate(predicate) {
  if (Array.isArray(predicate)) return predicate.length > 0;
  if (predicate && typeof predicate.length === "number") return predicate.length > 0;
  if (predicate && Object.prototype.toString.call(predicate) === "[object Object]") {
    return Object.keys(predicate).length > 0;
  }
  return false;
}

function sanitizeRollOption(option) {
  return String(option ?? "")
    .replace(/[^-:\w]/g, "")
    .replace(/:+/g, ":")
    .replace(/-+/g, "-")
    .trim();
}

function analyzeActiveEffectLikeSource(source, actor, item) {
  const problems = [];
  let preparedSource = source;
  const path = typeof source?.path === "string" ? source.path.trim() : "";

  if (!path) {
    problems.push({
      issue: "AE_LIKE_MISSING_PATH",
      field: "path",
      value: source?.path,
      details: "Ajouter le chemin Actor cible du Rule Element ActiveEffectLike. La regle reste inactive jusque-la."
    });
  }

  if (!AE_LIKE_MODES.has(source?.mode)) {
    problems.push({
      issue: "AE_LIKE_INVALID_MODE",
      field: "mode",
      value: source?.mode,
      details: `Choisir un mode ActiveEffectLike valide: ${Array.from(AE_LIKE_MODES).join(", ")}.`
    });
  }

  if (!Object.prototype.hasOwnProperty.call(source ?? {}, "value")) {
    problems.push({
      issue: "AE_LIKE_MISSING_VALUE",
      field: "value",
      value: undefined,
      details: "Ajouter la valeur appliquee par le Rule Element ActiveEffectLike."
    });
  } else if (typeof source.value === "string" && source.value.trim().length === 0) {
    problems.push({
      issue: "AE_LIKE_EMPTY_VALUE",
      field: "value",
      value: source.value,
      details: "Remplacer la formule vide par une valeur ou une formule valide."
    });
  }

  const injectableFields = ["path", "value", "label", "predicate"];
  for (const field of injectableFields) {
    if (!Object.prototype.hasOwnProperty.call(source ?? {}, field)) continue;
    const unresolved = findUnresolvedInjections(source[field], actor, item, source);
    for (const missing of unresolved) {
      problems.push({
        issue: "AE_LIKE_UNRESOLVED_INJECTION",
        field,
        value: missing.token,
        details: `La propriete injectee ${missing.token} est absente. Configurer le choix requis sur cet Item avant de reactiver la regle.`
      });
    }
  }

  if (path && !problems.some((problem) => problem.field === "path")) {
    const resolution = resolveInjectedString(path, actor, item, source);
    const resolvedPath = resolution.value.trim();
    const validPath = resolvedPath.length > 0 && [
      resolvedPath,
      resolvedPath.replace(/\.\w+$/, ""),
      resolvedPath.replace(/\.?\w+\.\w+$/, "")
    ].some((candidate) => getProperty(actor, candidate) !== undefined);

    if (!validPath) {
      problems.push({
        issue: "AE_LIKE_INVALID_PATH",
        field: "path",
        value: resolvedPath,
        details: "Le chemin cible et ses parents n'existent pas sur cet Actor. La regle reste inactive."
      });
    } else if (resolvedPath !== source.path) {
      preparedSource = { ...source, path: resolvedPath };
    }
  }

  return {
    source: preparedSource,
    problems: deduplicateRuleProblems(problems)
  };
}

function findUnresolvedInjections(value, actor, item, rule) {
  if (typeof value === "string") {
    return resolveInjectedString(value, actor, item, rule).unresolved;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => findUnresolvedInjections(entry, actor, item, rule));
  }
  if (value && Object.prototype.toString.call(value) === "[object Object]") {
    return Object.values(value).flatMap((entry) => findUnresolvedInjections(entry, actor, item, rule));
  }
  return [];
}

function resolveInjectedString(source, actor, item, rule) {
  let value = typeof source === "string" ? source : "";
  const unresolved = [];

  for (let pass = 0; pass < 8 && value.includes("{"); pass += 1) {
    let matched = false;
    const previousValue = value;
    value = value.replace(/{(actor|item|rule)\|([^{}]+)}/g, (token, scope, path) => {
      matched = true;
      const target = scope === "actor" ? actor : scope === "item" ? item : rule;
      const resolved = getProperty(target, path);
      if (resolved === undefined || resolved === null || resolved === "") {
        unresolved.push({ token, scope, path });
        return token;
      }
      return String(resolved);
    });
    if (!matched || value === previousValue) break;
  }

  return { value, unresolved: deduplicateInjectionProblems(unresolved) };
}

function deduplicateInjectionProblems(problems) {
  return Array.from(new Map(problems.map((problem) => [problem.token, problem])).values());
}

function deduplicateRuleProblems(problems) {
  return Array.from(new Map(
    problems.map((problem) => [`${problem.issue}|${problem.field}|${formatDiagnosticValue(problem.value)}`, problem])
  ).values());
}

function recordRuleElementIssue(item, ruleIndex, ruleKey, problem) {
  return recordRuntimeIssue(item, {
    ruleKey,
    issue: problem.issue,
    path: `system.rules.${ruleIndex}.${problem.field}`,
    value: formatDiagnosticValue(problem.value),
    trigger: "prepareRuleElements",
    details: problem.details
  });
}

function formatDiagnosticValue(value) {
  if (value === undefined) return "(undefined)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
    ruleKey: issueData.ruleKey ?? "",
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
