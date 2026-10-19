import { useEffect, useState } from "react";
import {
  acceptOperatorInvitation,
  confirmMfaEnrollment,
  createPartner,
  decidePlatformApproval,
  inviteOperator,
  operatorAction,
  platformActivations,
  platformApprovals,
  platformAudit,
  platformCommissions,
  platformLogin,
  platformLogout,
  platformMfa,
  platformOperators,
  platformOverview,
  platformPartners,
  platformStores,
  reviewActivation,
  setOperatorRole,
  setPartnerStatus,
  signOutEverywhere,
  startMfaEnrollment,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type {
  ActivationRecord,
  AuditEntry,
  MarketingPartner,
  OperatorRow,
  PartnerCommissionRow,
  PlatformApproval,
  PlatformLoginStep,
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

/** An invitation link carries its code in the fragment, so it never reaches server logs. */
function takeInviteCode(): string | null {
  const match = window.location.hash.match(/invite=([^&]+)/);
  if (!match) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(match[1]!);
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

type Tab = "queue" | "activations" | "partners" | "commissions" | "stores" | "approvals" | "operators" | "audit";
type Pending = { stage: "mfa_required" | "mfa_enrollment"; token: string; secret?: string; otpauthUrl?: string };

export function PlatformPage() {
  const [session, setSession] = useState<PlatformSession | null>(readSession);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [login, setLogin] = useState({ email: "", password: "", displayName: "", code: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("queue");
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [queue, setQueue] = useState<ActivationRecord[]>([]);
  const [activations, setActivations] = useState<ActivationRecord[]>([]);
  const [partners, setPartners] = useState<MarketingPartner[]>([]);
  const [commissions, setCommissions] = useState<PartnerCommissionRow[]>([]);
  const [stores, setStores] = useState<PlatformStore[]>([]);
  const [approvals, setApprovals] = useState<PlatformApproval[]>([]);
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [partnerForm, setPartnerForm] = useState({ code: "", name: "", email: "" });
  const [inviteForm, setInviteForm] = useState({ email: "", role: "verifier" as "verifier" | "admin" });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState("");

  const isAdmin = session?.operator.role === "admin";
  const myId = session?.operator.id ?? session?.operator.operatorId;

  async function refresh(token: string, admin: boolean) {
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
      if (admin) {
        const [ap, ops, au] = await Promise.all([platformApprovals(token), platformOperators(token), platformAudit(token)]);
        setApprovals(ap.approvals);
        setOperators(ops.operators);
        setAudit(au.entries);
      }
    } catch (err) {
      if ((err as { status?: number }).status === 401) {
        saveSession(null);
        setSession(null);
        setError("Your session ended. Sign in again.");
        return;
      }
      setError(err instanceof Error ? err.message : "Could not load the platform console.");
    }
  }

  useEffect(() => {
    const code = takeInviteCode();
    if (code) {
      saveSession(null);
      setSession(null);
      setInviteCode(code);
      return;
    }
    if (session) void refresh(session.token, session.operator.role === "admin");
  }, []);

  async function next(step: PlatformLoginStep) {
    if (step.stage === "complete") {
      const full: PlatformSession = { token: step.token, expiresAt: step.expiresAt, operator: step.operator };
      saveSession(full);
      setSession(full);
      setPending(null);
      setInviteCode(null);
      setLogin({ email: "", password: "", displayName: "", code: "" });
      await refresh(full.token, full.operator.role === "admin");
      return;
    }
    if (step.stage === "mfa_enrollment") {
      const setup = await startMfaEnrollment(step.token);
      setPending({ stage: "mfa_enrollment", token: step.token, secret: setup.secret, otpauthUrl: setup.otpauthUrl });
    } else {
      setPending({ stage: "mfa_required", token: step.token });
    }
    setLogin((l) => ({ ...l, password: "", code: "" }));
  }

  async function run(key: string, work: () => Promise<string>) {
    if (!session) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await refresh(session.token, isAdmin);
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
          style={{ maxWidth: 460 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              if (pending?.stage === "mfa_required") return await next(await platformMfa(pending.token, login.code));
              if (pending?.stage === "mfa_enrollment") return await next(await confirmMfaEnrollment(pending.token, login.code));
              if (inviteCode) return await next(await acceptOperatorInvitation(inviteCode, login.displayName, login.password));
              await next(await platformLogin(login.email, login.password));
            } catch (err) {
              setError(err instanceof Error ? err.message : "Sign-in failed");
            }
          }}
        >
          {pending?.stage === "mfa_enrollment" ? (
            <>
              <h2>Set up two-step verification</h2>
              <p className="muted small">
                Add this account to an authenticator app (for example Google Authenticator or Microsoft Authenticator) with the setup key below,
                then enter the 6-digit code it shows. You will need the app every time you sign in.
              </p>
              <p className="order-detail small" style={{ wordBreak: "break-all" }}>
                Setup key: <strong>{pending.secret}</strong>
                <br />
                <a href={pending.otpauthUrl}>Open in an authenticator app on this device</a>
              </p>
            </>
          ) : pending?.stage === "mfa_required" ? (
            <>
              <h2>Two-step verification</h2>
              <p className="muted small">Enter the 6-digit code from your authenticator app.</p>
            </>
          ) : inviteCode ? (
            <>
              <h2>Join the Digiconomy platform</h2>
              <p className="muted small">You were invited as an operator. Choose a password; next you'll set up two-step verification.</p>
              <label>
                Your name
                <input required value={login.displayName} onChange={(e) => setLogin({ ...login, displayName: e.target.value })} />
              </label>
              <label>
                Password (at least 12 characters)
                <input type="password" required minLength={12} autoComplete="new-password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <p className="muted small">For Digiconomy staff who verify store setup payments. Store owners use their store admin.</p>
              <label>
                Email
                <input type="email" required value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
              </label>
              <label>
                Password
                <input type="password" required autoComplete="current-password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
              </label>
            </>
          )}
          {pending ? (
            <label>
              6-digit code
              <input
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={login.code}
                onChange={(e) => setLogin({ ...login, code: e.target.value.replace(/\D/g, "") })}
              />
            </label>
          ) : null}
          {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
          <button className="btn">{pending ? "Verify" : inviteCode ? "Continue" : "Sign in"}</button>
          {pending ? (
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setPending(null);
                setError(null);
              }}
            >
              Start again
            </button>
          ) : null}
        </form>
      </div>
    );
  }

  const token = session.token;
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const tabs: Array<[Tab, string]> = [
    ["queue", `Verification queue (${queue.length})`],
    ["activations", "Activations"],
    ["partners", "Marketing partners"],
    ["commissions", "Commissions"],
    ["stores", "Stores"],
    ...(isAdmin
      ? ([
          ["approvals", `Approvals (${pendingApprovals.length})`],
          ["operators", "Operators"],
          ["audit", "Audit log"],
        ] as Array<[Tab, string]>)
      : []),
  ];
  const operatorName = (id: string | null) => operators.find((o) => o.id === id)?.displayName ?? (id ? `${id.slice(0, 8)}…` : "—");

  return (
    <div className="stack">
      <h1>Digiconomy platform</h1>
      <div className="row">
        <p className="muted small">
          Signed in as {session.operator.displayName} ({session.operator.role}) · two-step verified
        </p>
        <button
          className="btn ghost"
          type="button"
          onClick={() =>
            run("signout-all", async () => {
              const r = await signOutEverywhere(token);
              return `Signed out ${r.revoked} other session(s).`;
            })
          }
        >
          Sign out other devices
        </button>
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
        settled here. Partner payouts are disabled.
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
            <p className="muted small">{overview.partners.active ?? 0} active partners · payouts disabled</p>
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
                  <th>Draft documents</th>
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
                    <td className="small">
                      {(a.documents ?? []).map((d) => (
                        <div key={d.number}>
                          {d.kind} {d.number}
                          {d.status === "void" ? " (void)" : ""}
                        </div>
                      ))}
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
                                  return "Reversal requested. A different admin must approve it in Approvals before anything changes.";
                                })
                              }
                            >
                              Request reversal
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
                                const nextPartner = await setPartnerStatus(token, p.id, p.status === "active" ? "suspend" : "reactivate");
                                return `${nextPartner.code} is now ${nextPartner.status}.`;
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
          <p className="muted small">Commission records only. Payouts are disabled until a payout process is reviewed and approved.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Store</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Payout</th>
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
                    <td className="muted small">disabled</td>
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

      {tab === "approvals" && isAdmin ? (
        <section className="card stack">
          <p className="muted small">High-risk actions run only after a second admin approves them. You cannot approve your own request.</p>
          {approvals.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Requested</th>
                    <th>Action</th>
                    <th>Reason</th>
                    <th>By</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {approvals.map((a) => (
                    <tr key={a.id}>
                      <td>{new Date(a.createdAt).toLocaleString()}</td>
                      <td>
                        Reverse activation
                        <div className="muted small">{activations.find((x) => x.id === a.targetId)?.store?.name ?? a.targetId}</div>
                      </td>
                      <td>{a.reason}</td>
                      <td>{operatorName(a.requestedById)}</td>
                      <td className="status">
                        {a.status}
                        {a.decidedById ? <div className="muted small">by {operatorName(a.decidedById)}</div> : null}
                      </td>
                      <td>
                        {a.status === "pending" ? (
                          <div className="row">
                            <button
                              className="btn"
                              type="button"
                              disabled={busy !== "" || a.requestedById === myId}
                              title={a.requestedById === myId ? "Another admin must approve your request" : undefined}
                              onClick={() =>
                                run(`approve:${a.id}`, async () => {
                                  await decidePlatformApproval(token, a.id, "approve");
                                  return "Approved. The activation was reversed and its commission reversed.";
                                })
                              }
                            >
                              Approve
                            </button>
                            <button
                              className="btn ghost"
                              type="button"
                              disabled={busy !== ""}
                              onClick={() =>
                                run(`decline:${a.id}`, async () => {
                                  await decidePlatformApproval(token, a.id, "decline");
                                  return a.requestedById === myId ? "Request cancelled." : "Request declined.";
                                })
                              }
                            >
                              {a.requestedById === myId ? "Cancel request" : "Decline"}
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">No approval requests.</p>
          )}
        </section>
      ) : null}

      {tab === "operators" && isAdmin ? (
        <>
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run("invite", async () => {
                const invite = await inviteOperator(token, inviteForm.email, inviteForm.role);
                setInviteLink(`${window.location.origin}/platform#invite=${encodeURIComponent(invite.code ?? "")}`);
                setInviteForm({ email: "", role: "verifier" });
                return `Invitation created for ${invite.email}. Send them the link below; it works once and expires in 72 hours.`;
              });
            }}
          >
            <h2>Invite an operator</h2>
            <div className="row">
              <label>
                Email
                <input type="email" required value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} />
              </label>
              <label>
                Role
                <select value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value as "verifier" | "admin" })}>
                  <option value="verifier">Verifier: reviews setup payments</option>
                  <option value="admin">Admin: also partners, operators, approvals</option>
                </select>
              </label>
            </div>
            <button className="btn secondary" type="submit" disabled={busy !== ""}>
              Create invitation
            </button>
            {inviteLink ? (
              <p className="order-detail small" style={{ wordBreak: "break-all" }}>
                One-time invitation link (shown once): <strong>{inviteLink}</strong>
              </p>
            ) : null}
          </form>
          <section className="card">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Operator</th>
                    <th>Role</th>
                    <th>Two-step</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {operators.map((o) => {
                    const self = o.id === myId;
                    return (
                      <tr key={o.id}>
                        <td>
                          {o.displayName}
                          <div className="muted small">{o.email}</div>
                        </td>
                        <td>
                          <select
                            aria-label={`Role of ${o.displayName}`}
                            value={o.role}
                            disabled={self || busy !== ""}
                            onChange={(e) =>
                              run(`role:${o.id}`, async () => {
                                await setOperatorRole(token, o.id, e.target.value as "verifier" | "admin");
                                return `${o.displayName} is now ${e.target.value}; their sessions were ended.`;
                              })
                            }
                          >
                            <option value="verifier">verifier</option>
                            <option value="admin">admin</option>
                          </select>
                        </td>
                        <td>{o.mfaEnabled ? "on" : "not set up"}</td>
                        <td className="status">{o.status}</td>
                        <td>
                          {self ? (
                            <span className="muted small">you</span>
                          ) : (
                            <div className="row">
                              <button
                                className="btn ghost"
                                type="button"
                                disabled={busy !== ""}
                                onClick={() =>
                                  run(`status:${o.id}`, async () => {
                                    await operatorAction(token, o.id, o.status === "active" ? "suspend" : "reactivate");
                                    return `${o.displayName} ${o.status === "active" ? "suspended" : "reactivated"}.`;
                                  })
                                }
                              >
                                {o.status === "active" ? "Suspend" : "Reactivate"}
                              </button>
                              <button
                                className="btn ghost"
                                type="button"
                                disabled={busy !== ""}
                                onClick={() =>
                                  run(`mfa:${o.id}`, async () => {
                                    await operatorAction(token, o.id, "reset-mfa");
                                    return `${o.displayName} must set up two-step verification again at next sign-in.`;
                                  })
                                }
                              >
                                Reset two-step
                              </button>
                              <button
                                className="btn ghost"
                                type="button"
                                disabled={busy !== ""}
                                onClick={() =>
                                  run(`sessions:${o.id}`, async () => {
                                    await operatorAction(token, o.id, "revoke-sessions");
                                    return `${o.displayName} was signed out everywhere.`;
                                  })
                                }
                              >
                                Sign out
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {tab === "audit" && isAdmin ? (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>By</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{new Date(e.at).toLocaleString()}</td>
                    <td className="small">{e.action}</td>
                    <td className="small">{e.actorKind === "platform_operator" ? operatorName(e.actorId) : e.actorKind}</td>
                    <td className="small muted">
                      {e.resource} {e.resourceId ? `${e.resourceId.slice(0, 10)}…` : ""}
                    </td>
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
