const openMenus = new Set<() => void>();

/** Register a menu as the open one; dismiss any menu that was open before it. */
export function registerOpenMenu(dismiss: () => void) {
  const previous = [...openMenus];
  openMenus.clear();
  openMenus.add(dismiss);
  previous.forEach((close) => close());
}

export function unregisterOpenMenu(dismiss: () => void) {
  openMenus.delete(dismiss);
}
