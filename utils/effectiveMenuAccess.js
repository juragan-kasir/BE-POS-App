'use strict'

// DR-24 C-02 / DR-12 §35.4: the effective per-account menu permission list,
// resolved with exactly the client's semantics (src/utils/permission.js and
// src/utils/role.js) so the server and the UI never disagree:
//   * an own user.accessMenu wins; otherwise the account's role.accessMenu;
//   * legacy action vocabulary is normalized (read->view, create->add,
//     update->edit, upload->import, download->export);
//   * menu keys match verbatim or "stripped" (the client removes the leading
//     slash and -list/-page/-super-admin suffixes);
//   * a super_admin that carries NO own accessMenu bypasses menu checks (it
//     is the platform operator); a super_admin WITH an own menu is scoped and
//     IS enforced (mirrors accessMenuScoped at login).

const LEGACY_ACTION_MAP = Object.freeze({
  read: 'view',
  create: 'add',
  update: 'edit',
  upload: 'import',
  download: 'export'
})

const parseAccessMenu = (accessMenu) => {
  if (Array.isArray(accessMenu)) return accessMenu
  if (typeof accessMenu === 'string') {
    try {
      const parsed = JSON.parse(accessMenu)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

const stripMenuKey = (menuKey) => {
  if (typeof menuKey !== 'string') return ''
  return menuKey
    .replace('/', '')
    .replace('-list', '')
    .replace('-page', '')
    .replace('-super-admin', '')
}

const normalizeMenuActions = (entry) => {
  const out = {}
  for (const [key, value] of Object.entries(entry || {})) {
    if (key === 'menu') continue
    out[LEGACY_ACTION_MAP[key] || key] = value
  }
  return out
}

const menuEntryMatches = (entry, menuKey) =>
  Boolean(entry) && (entry.menu === menuKey || entry.menu === stripMenuKey(menuKey))

const canMenuAction = (entries, menuKey, action) => {
  if (!Array.isArray(entries)) return false
  const entry = entries.find((m) => menuEntryMatches(m, menuKey))
  if (!entry) return false
  return Boolean(normalizeMenuActions(entry)[action])
}

const bypassesMenuPermissions = (account) =>
  Boolean(account) &&
  account.roleType === 'super_admin' &&
  parseAccessMenu(account.accessMenu).length === 0

// Merged effective list, mirroring the login resolution: own list first,
// role list as fallback when the own list is empty.
const resolveEffectiveMenuAccess = async (db, account) => {
  if (!account) return { entries: [], scoped: false, bypass: false }
  const bypass = bypassesMenuPermissions(account)
  let entries = parseAccessMenu(account.accessMenu)
  if (entries.length === 0 && account.roleId) {
    const role = await db.role.findByPk(account.roleId, { attributes: ['id', 'accessMenu'] })
    entries = parseAccessMenu(role?.accessMenu)
  }
  return { entries, scoped: entries.length > 0, bypass }
}

module.exports = {
  LEGACY_ACTION_MAP,
  parseAccessMenu,
  stripMenuKey,
  normalizeMenuActions,
  menuEntryMatches,
  canMenuAction,
  bypassesMenuPermissions,
  resolveEffectiveMenuAccess
}
