import { useEffect, useState } from "react";
import {
  createPartner,
  platformActivations,
  platformCommissions,
  platformLogin,
  platformLogout,
  platformOverview,
  platformPartners,
  platformStores,
  reviewActivation,
  setPartnerStatus,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type {
  ActivationRecord,
  MarketingPartner,
  PartnerCommissionRow,
  PlatformOverview,
  PlatformSession,
  PlatformStore,
} from "../lib/types";

/** Operator sessions live only for this browser tab. */
const SESSION_KEY = "eco_platform_session";

function readSession(): PlatformSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const row = raw ? (JSON.parse(raw) as PlatformSession) : null;
    return row && new Date(row.expiresAt).getTime() > Date.now() ? row : null;
  } catch {
    return null;
  }
}

function saveSession(session: PlatformSession | null) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* the session still works on this page */
  }
}

function totals(byCurrency: Record<string, number>) {
  const entries = Object.entries(byCurrency);
  return entries.length ? entries.map(([currency, minor]) => formatMoney(minor, currency)).join(" · ") : "—";
}

const STATUS_TEXT: Record<string, string> = {
  payment_submitted: "Awaiting verification",
  verified: "Verified",
  rejected: "Rejected",
  reversed: "Reversed",
};

type Tab = "queue" | "activations" | "partners" | "commissions" | "stores";

export function PlatformPage() {
  const [session, setSession] = useState<PlatformSession | null>(readSession);
  const [login, setLogin] = useState({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("queue");
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [queue, setQueue] = useState<ActivationRecord[]>([]);
  const [activations, setActivations] = useState<ActivationRecord[]>([]);
  const [partners, setPartners] = useState<MarketingPartner[]>([]);
  const [commissions, setCommissions] = useState<PartnerCommissionRow[]>([]);
  const [stores, setStores] = useState<PlatformStore[]>([]);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [partnerForm, setPartnerForm] = useState({ code: "", name: "", email: "" });
  const [busy, setBusy] = useState("");

  const isAdmin = session?.operator.role === "admin";

  async function refresh(token: string) {
    try {
      const [o, q, a, p, c, s] = await Promise.all([
        platformOverview(token),
        platformActivations(token, "payment_submitted"),
        platformActivations(token),
        platformPartners(token),
        platformCommissions(token),
        platformStores(token),
      ]);
      setOverview(o);
      setQueue(q.activations);
      setActivations(a.activations);
      setPartners(p.partners);
      setCommissions(c.commissions);
      setStores(s.stores);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        saveSession(null);
        setSession(null);
      }
      setError(err instanceof Error ? err.message : "Could not load the platform console.");
    }
  }

  useEffect(() => {
    if (session) void refresh(session.token);
  }, []);

  async function run(key: string, work: () => Promise<string>) {
    if (!session) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await refresh(session.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The action did not complete.");
    } finally {
      setBusy("");
    }
  }

  if (!session) {
    return (
      <div className="stack">
        <h1>Digiconomy platform</h1>
        <form
          className="card stack"
          style={{ maxWidth: 420 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const next = await platformLogin(login.email, login.password);
              saveSession(next);
              setSession(next);
              setLogin({ email: "", password: "" });
              await refresh(next.token);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Sign-in failed");
            }
          }}
        >
          <p className="muted small">For Digiconomy staff who verify store setup payments. Store owners use their store admin.</p>
          <label>
            Email
            <input type="email" required value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
          </label>
          <label>
            Password
            <input type="password" required value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
          </label>
          {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
          <button className="btn">Sign in</button>
        </form>
      </div>
    );
  }

  const token = session.token;
  const tabs: Array<[Tab, string]> = [
    ["queue", `Verification queue (${queue.length})`],
    ["activations", "Activations"],
    ["partners", "Marketing partners"],
    ["commissions", "Commissions"],
    ["stores", "Stores"],
  ];

  return (
    <div className="stack">
      <h1>Digiconomy platform</h1>
      <div className="row">
        <p className="muted small">
          Signed in as {session.operator.displayName} ({session.operator.role})
        </p>
        <button
          className="btn ghost"
          type="button"
          onClick={async () => {
            await platformLogout(token);
            saveSession(null);
            setSession(null);
          }}
        >
          Sign out
        </button>
      </div>
      <div className="banner small">
        Manual verification only: confirm each transfer in the bank account before verifying. No payment is collected or
        settled here.
      </div>

      {overview ? (
        <div className="grid">
          <article className="card">
            <p className="eyebrow">Stores</p>
            <h3>{Object.values(overview.stores).reduce((a, b) => a + b, 0)}</h3>
            <p className="muted small">
              {overview.stores.active ?? 0} active · {overview.stores.pending ?? 0} awaiting setup · {overview.stores.legacy ?? 0}{" "}
              grandfathered
            </p>
          </article>
          <article className="card">
            <p className="eyebrow">Awaiting verification</p>
            <h3>{overview.activations.payment_submitted ?? 0}</h3>
            <p className="muted small">{overview.activationRequired ? "New stores open after verification" : "Activation not required yet"}</p>
          </article>
          <article className="card">
            <p className="eyebrow">Verified setup fees</p>
            <h3 className="price">{totals(overview.verifiedSetupFeesMinor)}</h3>
          </article>
          <article className="card">
            <p className="eyebrow">Partner commission accrued</p>
            <h3 className="price">
              {totals(
                Object.fromEntries(
                  overview.commissionsMinor.filter((c) => c.status === "accrued").map((c) => [c.currency, c.amountMinor]),
                ),
              )}
            </h3>
            <p className="muted small">{overview.partners.active ?? 0} active partners</p>
          </article>
        </div>
      ) : null}

      <nav className="tabs" aria-label="Platform sections">
        {tabs.map(([key, label]) => (
          <button key={key} className={tab === key ? "tab active" : "tab"} type="button" onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {notice ? <p className="muted small" role="status">{notice}</p> : null}
      {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}

      {tab === "queue" ? (
        queue.length ? (
          <div className="grid">
            {queue.map((a) => (
              <article key={a.id} className="card stack">
                <p className="eyebrow">{a.store?.slug}</p>
                <h3>{a.store?.name}</h3>
                <p className="price">{formatMoney(a.amountMinor, a.currency)}</p>
                <p className="small">
                  Reference <strong>{a.paymentReference}</strong> · paid by {a.payerName}
                  {a.paidAt ? ` on ${new Date(a.paidAt).toLocaleDateString()}` : ""}
                </p>
                <p className="muted small">
                  {a.plan === "early_adopter" ? "Early-adopter setup" : "Standard setup"} · submitted{" "}
                  {new Date(a.submittedAt).toLocaleString()}
                  {a.partner ? ` · referred by ${a.partner.code}` : ""}
                </p>
                <label>
                  Amount received ({a.currency})
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={received[a.id] ?? ""}
                    onChange={(e) => setReceived({ ...received, [a.id]: e.target.value })}
                  />
                </label>
                <button
                  className="btn"
                  type="button"
                  disabled={busy !== "" || !received[a.id]}
                  onClick={() =>
                    run(`verify:${a.id}`, async () => {
                      await reviewActivation(token, a.id, "verify", {
                        amountReceivedMinor: Math.round(Number(received[a.id]) * 100),
                        currency: a.currency,
                      });
                      return `Verified ${a.store?.name}. The store is now open.`;
                    })
                  }
                >
                  Verify payment
                </button>
                <label>
                  Reason to reject
                  <input value={reasons[a.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [a.id]: e.target.value })} />
                </label>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy !== "" || (reasons[a.id] ?? "").trim().length < 3}
                  onClick={() =>
                    run(`reject:${a.id}`, async () => {
                      await reviewActivation(token, a.id, "reject", { reason: reasons[a.id] });
                      return `Rejected the submission from ${a.store?.name}.`;
                    })
                  }
                >
                  Reject
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty">No setup payments are awaiting verification.</p>
        )
      ) : null}

      {tab === "activations" ? (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Setup</th>
                  <th>Reference</th>
                  <th>Partner</th>
                  <th>Commission</th>
                  <th>Status</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {activations.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.store?.name}
                      <div className="muted small">{a.store?.slug}</div>
                    </td>
                    <td>{formatMoney(a.amountMinor, a.currency)}</td>
                    <td>{a.paymentReference}</td>
                    <td>{a.partner?.code ?? "—"}</td>
                    <td>
                      {a.commission ? `${formatMoney(a.commission.amountMinor, a.commission.currency)} (${a.commission.status})` : "—"}
                    </td>
                    <td>
                      <span className="status">{STATUS_TEXT[a.status] ?? a.status}</span>
                      {a.rejectedReason || a.reversedReason ? (
                        <div className="muted small">{a.rejectedReason ?? a.reversedReason}</div>
                      ) : null}
                    </td>
                    {isAdmin ? (
                      <td>
                        {a.status === "verified" ? (
                          <div className="stack">
                            <input
                              aria-label="Reason to reverse"
                              placeholder="Reason to reverse"
                              value={reasons[a.id] ?? ""}
                              onChange={(e) => setReasons({ ...reasons, [a.id]: e.target.value })}
                            />
                            <button
                              className="btn ghost"
                              type="button"
                              disabled={busy !== "" || (reasons[a.id] ?? "").trim().length < 3}
                              onClick={() =>
                                run(`reverse:${a.id}`, async () => {
                                  await reviewActivation(token, a.id, "reverse", { reason: reasons[a.id] });
                                  return `Reversed. ${a.store?.name} is closed again and any commission was reversed.`;
                                })
                              }
                            >
                              Reverse
                            </button>
                          </div>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === "partners" ? (
        <>
          {isAdmin ? (
            <form
              className="card stack"
              onSubmit={(e) => {
                e.preventDefault();
                void run("partner:create", async () => {
                  const created = await createPartner(token, partnerForm);
                  setPartnerForm({ code: "", name: "", email: "" });
                  return `Added partner ${created.code}.`;
                });
              }}
            >
              <h2>Add marketing partner</h2>
              <p className="muted small">Partners earn 5% of each verified setup payment they refer. Customer orders earn nothing.</p>
              <div className="row">
                <label>
                  Referral code
                  <input required value={partnerForm.code} onChange={(e) => setPartnerForm({ ...partnerForm, code: e.target.value })} />
                </label>
                <label>
                  Name
                  <input required value={partnerForm.name} onChange={(e) => setPartnerForm({ ...partnerForm, name: e.target.value })} />
                </label>
                <label>
                  Email
                  <input type="email" required value={partnerForm.email} onChange={(e) => setPartnerForm({ ...partnerForm, email: e.target.value })} />
                </label>
              </div>
              <button className="btn secondary" type="submit" disabled={busy !== ""}>
                Add partner
              </button>
            </form>
          ) : null}
          <section className="card">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Partner</th>
                    <th>Referrals</th>
                    <th>Accrued</th>
                    <th>Reversed</th>
                    <th>Status</th>
                    {isAdmin ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {partners.map((p) => (
                    <tr key={p.id}>
                      <td>{p.code}</td>
                      <td>
                        {p.name}
                        <div className="muted small">{p.email}</div>
                      </td>
                      <td>
                        {p.verifiedReferrals} verified / {p.referrals}
                      </td>
                      <td>{totals(p.commissionAccruedMinor)}</td>
                      <td>{totals(p.commissionReversedMinor)}</td>
                      <td className="status">{p.status}</td>
                      {isAdmin ? (
                        <td>
                          <button
                            className="btn ghost"
                            type="button"
                            disabled={busy !== ""}
                            onClick={() =>
                              run(`partner:${p.id}`, async () => {
                                const next = await setPartnerStatus(token, p.id, p.status === "active" ? "suspend" : "reactivate");
                                return `${next.code} is now ${next.status}.`;
                              })
                            }
                          >
                            {p.status === "active" ? "Suspend" : "Reactivate"}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {tab === "commissions" ? (
        <section className="card">
          <p className="muted small">Commission records only. Paying partners out is outside this app and needs separate approval.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Store</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {commissions.map((c) => (
                  <tr key={c.id}>
                    <td>{c.partner.code}</td>
                    <td>{c.store.name}</td>
                    <td>
                      {formatMoney(c.amountMinor, c.currency)} <span className="muted small">({c.rateBps / 100}%)</span>
                    </td>
                    <td className="status">{c.status}</td>
                    <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === "stores" ? (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Handle</th>
                  <th>Setup</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.tenantId}>
                    <td>{s.name}</td>
                    <td>{s.slug}</td>
                    <td className="status">{s.activationStatus}</td>
                    <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
