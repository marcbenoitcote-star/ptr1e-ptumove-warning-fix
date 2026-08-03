const MODULE_ID = "ptr1e-ptumove-warning-fix";
const SUPPORTED_SYSTEM_VERSION = "4.4.3.37";
const PATCH_FLAG = Symbol.for(`${MODULE_ID}.patched`);

Hooks.once("init", () => {
  if (game.system.id !== "ptu") return;

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
      return this;
    }
  });

  Object.defineProperty(MoveClass.prototype, PATCH_FLAG, {
    configurable: true,
    value: true
  });

  console.info(`${MODULE_ID} | Patched PTUMove#item for PTR ${SUPPORTED_SYSTEM_VERSION}.`);
});
