/**
 * The distinct identifiers of a store, kept apart on purpose:
 *   store         tenant.id
 *   installation  the LifeOS Portal install it was created for
 *   business      the LifeOS business it belongs to (minted by Portal, immutable)
 *   owner         the owner's subject on the owner staff row
 * Nothing here is derived from another identifier.
 */
type StoreIdentityRow = {
  slug: string;
  lifeosBusinessId: string | null;
  settings: unknown;
  portalInstall?: { installId: string } | null;
};

function distributorTenantIdOf(settings: unknown): string | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  const value = (settings as Record<string, unknown>).distributorTenantId;
  return typeof value === "string" ? value : undefined;
}

/** The Portal install: the binding row, or for stores created before it, the id Portal sent then. */
export function installIdOf(tenant: StoreIdentityRow): string | null {
  return tenant.portalInstall?.installId ?? distributorTenantIdOf(tenant.settings) ?? null;
}

/**
 * The business id Portal supplied, or null. Two older values are not business ids and read as null,
 * so the stable id can be bound once: the install id stored in its place when Portal sent none, and
 * "biz_<the store's own subdomain>", which Portal derived from the subdomain until the stable id.
 */
export function businessIdOf(tenant: StoreIdentityRow): string | null {
  const value = tenant.lifeosBusinessId;
  if (!value || value === distributorTenantIdOf(tenant.settings) || value === `biz_${tenant.slug}`) return null;
  return value;
}
