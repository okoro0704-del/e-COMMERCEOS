export function formatMoney(minor: number, currency = "NGN") {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

export function storeSubdomain() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("store")?.trim().toLowerCase();
  if (fromQuery) return fromQuery;

  const host = window.location.hostname.toLowerCase();
  if (host.endsWith(".lifeos.app")) {
    return host.replace(".lifeos.app", "").split(".")[0] ?? "demo";
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
