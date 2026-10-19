export function formatMoney(minor: number, currency = "NGN") {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

const STORE_KEY = "eco_store";

/**
 * The store being browsed: ?store= (remembered for this tab, so in-app links keep it), else the
 * store subdomain of the host, else the store remembered earlier in this tab.
 */
export function storeSubdomain() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("store")?.trim().toLowerCase();
  if (fromQuery) {
    try {
      sessionStorage.setItem(STORE_KEY, fromQuery);
    } catch {
      /* still works for this page */
    }
    return fromQuery;
  }

  const host = window.location.hostname.toLowerCase();
  if (host.endsWith(".getlifeos.app")) {
    return host.replace(".getlifeos.app", "").split(".")[0] ?? "demo";
  }
  if (host.endsWith(".lifeos.app")) {
    return host.replace(".lifeos.app", "").split(".")[0] ?? "demo";
  }
  try {
    const remembered = sessionStorage.getItem(STORE_KEY);
    if (remembered) return remembered;
  } catch {
    /* no storage: fall back to the preview store */
  }
  return "demo";
}

export function buyerToken() {
  const key = "eco_buyer_token";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const token = `TD-buyer-${crypto.randomUUID()}`;
  localStorage.setItem(key, token);
  return token;
}
