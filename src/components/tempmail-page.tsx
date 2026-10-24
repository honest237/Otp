"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, Copy, ImageOff, Inbox, Mail, MailPlus, Paperclip, RefreshCw, ShieldAlert, Timer, Trash2, X } from "lucide-react";
import { api, useStore } from "./app-provider";
import { EmptyState, InlineError, Loading, Spinner } from "./ui";
import type { MailboxView, MessageFull, MessageSummary, ProviderOption } from "@/lib/tempmail-core";

const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const left = (iso: string) => { const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return "Expired"; const m = Math.floor(ms / 60000); return m < 60 ? `${m} min left` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${Math.floor(m / 1440)}d left`; };
const sizeLabel = (n: number | null) => n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const initials = (m: { fromName: string; from: string }) => ((m.fromName || m.from || "?").trim()[0] || "?").toUpperCase();
async function copy(text: string) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

function frameDoc(html: string, images: boolean) {
  const csp = `default-src 'none'; img-src data: ${images ? "https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:14px;color:#142344;background:#fff;word-break:break-word}img{max-width:100%;height:auto}a{color:#1754f5}</style>${html}`;
}

export function TempMailPage() {
  const { user, accountLoading, openPanel, notify } = useStore();
  const [providers, setProviders] = useState<ProviderOption[]>([]); const [boxes, setBoxes] = useState<MailboxView[] | null>(null); const [max, setMax] = useState(5); const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null); const [messages, setMessages] = useState<MessageSummary[] | null>(null); const [listError, setListError] = useState(""); const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null); const [detail, setDetail] = useState<MessageFull | null>(null); const [detailBusy, setDetailBusy] = useState(false); const [detailError, setDetailError] = useState(""); const [images, setImages] = useState(false);
  const [creating, setCreating] = useState(false); const [provider, setProvider] = useState<string>(""); const [name, setName] = useState(""); const [createBusy, setCreateBusy] = useState(false); const [createError, setCreateError] = useState("");
  const [copied, setCopied] = useState(""); const [, tick] = useState(0); const seen = useRef(new Set<string>());
  const active = boxes?.find(b => b.id === activeId) || null;

  const loadBoxes = useCallback(async () => {
    const r = await api<{ providers: ProviderOption[]; mailboxes: MailboxView[]; max: number }>("/api/tempmail"); setProviders(r.providers); setBoxes(r.mailboxes); setMax(r.max);
    setActiveId(cur => (cur && r.mailboxes.some(b => b.id === cur) ? cur : r.mailboxes[0]?.id ?? null)); setProvider(p => p || r.providers[0]?.id || "");
  }, []);
  useEffect(() => { if (accountLoading) return; if (!user) { setBoxes([]); return; } loadBoxes().catch(e => { setError((e as Error).message); setBoxes([]); }); }, [user?.id, accountLoading, loadBoxes]);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(t); }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!activeId) return; if (!quiet) setRefreshing(true);
    try { const r = await api<{ messages: MessageSummary[] }>(`/api/tempmail/${activeId}/messages`); setMessages(r.messages); setListError(""); }
    catch (e) { const msg = (e as Error).message; setListError(msg); if (/expired/i.test(msg)) loadBoxes().catch(() => {}); }
    finally { setRefreshing(false); }
  }, [activeId, loadBoxes]);
  useEffect(() => { setMessages(null); setOpenId(null); setDetail(null); setListError(""); seen.current = new Set(); if (!activeId) return; refresh(true); const t = setInterval(() => { if (document.visibilityState === "visible") refresh(true); }, 7000); return () => clearInterval(t); }, [activeId, refresh]);
  useEffect(() => { if (!messages) return; if (seen.current.size && messages.some(m => !seen.current.has(m.id))) notify("New email arrived."); seen.current = new Set(messages.map(m => m.id)); }, [messages, notify]);

  async function openMessage(id: string) {
    setOpenId(id); setDetail(null); setDetailError(""); setDetailBusy(true); setImages(false);
    try { const r = await api<{ message: MessageFull }>(`/api/tempmail/${activeId}/messages/${encodeURIComponent(id)}`); setDetail(r.message); setMessages(list => list?.map(m => m.id === id ? { ...m, seen: true } : m) ?? list); }
    catch (e) { setDetailError((e as Error).message); } finally { setDetailBusy(false); }
  }
  async function deleteMessage() {
    if (!openId) return; const id = openId;
    try { await api(`/api/tempmail/${activeId}/messages/${encodeURIComponent(id)}`, { method: "DELETE" }); setMessages(l => l?.filter(m => m.id !== id) ?? l); setOpenId(null); setDetail(null); } catch (e) { notify((e as Error).message, "error"); }
  }
  async function create() {
    setCreateBusy(true); setCreateError("");
    try { const r = await api<{ mailbox: MailboxView }>("/api/tempmail", { method: "POST", body: JSON.stringify({ provider, name: name.trim() }) }); setBoxes(b => [r.mailbox, ...(b || [])]); setActiveId(r.mailbox.id); setCreating(false); setName(""); }
    catch (e) { setCreateError((e as Error).message); } finally { setCreateBusy(false); }
  }
  async function closeBox() {
    if (!active || !confirm(`Close ${active.address}? Its messages will no longer be reachable here.`)) return;
    try { await api(`/api/tempmail/${active.id}`, { method: "DELETE" }); setBoxes(b => b?.filter(x => x.id !== active.id) ?? b); setActiveId(null); await loadBoxes(); } catch (e) { notify((e as Error).message, "error"); }
  }
  async function extend() { if (!active) return; try { const r = await api<{ mailbox: MailboxView }>(`/api/tempmail/${active.id}`, { method: "POST", body: "{}" }); setBoxes(b => b?.map(x => x.id === r.mailbox.id ? r.mailbox : x) ?? b); notify("Mailbox extended."); } catch (e) { notify((e as Error).message, "error"); } }
  async function doCopy(text: string, key: string) { if (await copy(text)) { setCopied(key); setTimeout(() => setCopied(""), 1600); } else notify("Couldn’t copy. Select and copy it manually.", "error"); }
  const current = providers.find(p => p.id === provider); const frame = useMemo(() => detail?.html ? frameDoc(detail.html, images) : "", [detail?.html, images]);
  const unread = messages?.filter(m => !m.seen).length ?? 0;

  const head = <header className="tm-heading"><span className="eyebrow">PRIVATE · DISPOSABLE · INSTANT</span><h1>Temp mail</h1><p>Open a throwaway address, use it for a sign-up, and read what arrives right here.</p></header>;
  if (accountLoading || boxes === null) return <main className="site-main inner-main tm-page">{head}<Loading label="Opening your inbox…"/></main>;
  if (!user) return <main className="site-main inner-main tm-page">{head}<EmptyState title="Sign in to open a mailbox" description="Your mailboxes are tied to your account so only you can read them." icon={<Mail size={32}/>}><button className="button button-primary" onClick={() => openPanel("login")}>Sign in<ArrowRight size={16}/></button></EmptyState></main>;

  const picker = <section className="tm-create"><div className="tm-create-head"><h2>New mailbox</h2>{boxes.length > 0 && <button className="icon-button" aria-label="Cancel" onClick={() => setCreating(false)}><X size={18}/></button>}</div>
    {!providers.length ? <InfoNotice>Temp mail isn’t available right now. Please check back soon.</InfoNotice> : <>
      <div className="tm-providers" role="radiogroup" aria-label="Mailbox version">{providers.map(p => <button key={p.id} type="button" role="radio" aria-checked={p.id === provider} className={`tm-provider ${p.id === provider ? "selected" : ""}`} onClick={() => setProvider(p.id)}><strong>{p.label}</strong><small>{p.note}</small></button>)}</div>
      {current?.customName && <label className="tm-name"><span>Address name (optional)</span><input value={name} maxLength={30} placeholder="Leave blank for a random one" autoComplete="off" autoCapitalize="none" onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}/></label>}
      <InlineError message={createError}/>
      <button className="button button-primary" disabled={createBusy || !provider || boxes.length >= max} onClick={create}>{createBusy ? <Spinner/> : <><MailPlus size={16}/>Create mailbox</>}</button>
      {boxes.length >= max && <p className="tm-hint">You have {max} open mailboxes. Close one to open another.</p>}
      <p className="tm-hint"><ShieldAlert size={13}/>Anyone who knows an address can read its inbox. Don’t use temp mail for banking, work or anything you need to recover later.</p></>}</section>;

  if (!boxes.length || creating) return <main className="site-main inner-main tm-page">{head}<InlineError message={error}/>{picker}</main>;

  return <main className="site-main inner-main tm-page">{head}<InlineError message={error}/>
    <div className="tm-tabs" role="tablist" aria-label="Your mailboxes">{boxes.map(b => <button key={b.id} role="tab" aria-selected={b.id === activeId} className={b.id === activeId ? "selected" : ""} onClick={() => setActiveId(b.id)}><span>{b.label}</span><small>{b.address.split("@")[0]}</small></button>)}{boxes.length < max && <button className="tm-tab-add" onClick={() => setCreating(true)} aria-label="New mailbox"><MailPlus size={16}/>New</button>}</div>
    {active && <section className="tm-shell">
      <div className="tm-address-bar"><div className="tm-address"><span className="tm-badge">{active.label}</span><strong>{active.address}</strong></div>
        <div className="tm-bar-actions"><button className="button button-secondary button-small" onClick={() => doCopy(active.address, "addr")}>{copied === "addr" ? <><Check size={14}/>Copied</> : <><Copy size={14}/>Copy</>}</button><button className="icon-button" aria-label="Refresh inbox" onClick={() => refresh()} disabled={refreshing}><RefreshCw size={17} className={refreshing ? "spin" : ""}/></button>{active.canExtend && <button className="icon-button" aria-label="Add time" title="Add time" onClick={extend}><Timer size={17}/></button>}<button className="icon-button" aria-label="Close mailbox" title="Close mailbox" onClick={closeBox}><Trash2 size={17}/></button></div>
        <div className="tm-meta"><span><Clock3 size={13}/>{left(active.expiresAt)}</span><span><Inbox size={13}/>{messages ? `${messages.length} message${messages.length === 1 ? "" : "s"}${unread ? ` · ${unread} unread` : ""}` : "Checking…"}</span><span className="tm-live"><i/>Live</span></div></div>
      <div className={`tm-split ${openId ? "reading" : ""}`}>
        <div className="tm-list" role="list">{listError && <div className="tm-list-error"><InlineError message={listError}/></div>}
          {messages === null && !listError ? <Loading label="Checking for mail…"/> : messages && !messages.length ? <div className="tm-empty"><span><Mail size={26}/></span><h3>Waiting for your first email</h3><p>Use <b>{active.address}</b> on a sign-up form. New mail shows up here by itself.</p></div> :
            messages?.map(m => <button role="listitem" key={m.id} className={`tm-row ${m.id === openId ? "selected" : ""} ${m.seen ? "" : "unread"}`} onClick={() => openMessage(m.id)}><span className="tm-avatar">{initials(m)}</span><span className="tm-row-main"><span className="tm-row-top"><strong>{m.fromName || m.from || "Unknown sender"}</strong><time>{ago(m.date)}</time></span><span className="tm-subject">{m.subject || "(no subject)"}</span>{(m.code || m.hasAttachments) && <span className="tm-chips">{m.code && <span className="tm-code-chip">Code {m.code}</span>}{m.hasAttachments && <Paperclip size={12}/>}</span>}</span></button>)}</div>
        <article className="tm-reader" aria-live="polite">
          {!openId ? <div className="tm-empty tm-reader-empty"><span><Mail size={26}/></span><h3>Select a message</h3><p>Pick an email on the left to read it.</p></div> :
            <><button className="tm-back" onClick={() => { setOpenId(null); setDetail(null); }}><ArrowLeft size={15}/>Inbox</button>
              {detailBusy ? <Loading label="Opening message…"/> : detailError ? <InlineError message={detailError}/> : detail && <>
                <div className="tm-reader-head"><h2>{detail.subject || "(no subject)"}</h2><div className="tm-reader-from"><span className="tm-avatar">{initials(detail)}</span><div><strong>{detail.fromName || detail.from}</strong>{detail.fromName && <small>{detail.from}</small>}</div><time>{new Date(detail.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></div></div>
                {detail.code && <div className="tm-code"><div><small>Verification code</small><strong>{detail.code}</strong></div><button className="button button-primary button-small" onClick={() => doCopy(detail.code!, "code")}>{copied === "code" ? <><Check size={14}/>Copied</> : <><Copy size={14}/>Copy code</>}</button></div>}
                {detail.html ? <>{!images && <div className="tm-images"><ImageOff size={14}/>Remote images are blocked to protect your privacy.<button onClick={() => setImages(true)}>Show images</button></div>}<iframe className="tm-frame" title="Email content" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={frame}/></> : <pre className="tm-text">{detail.text || "This message has no content."}</pre>}
                {detail.attachments.length > 0 && <div className="tm-attachments"><h4><Paperclip size={14}/>Attachments</h4>{detail.attachments.map((a, i) => <span key={i}>{a.name}<small>{sizeLabel(a.size)}</small></span>)}<p>Attachments can’t be downloaded here.</p></div>}
                <div className="tm-reader-actions"><button className="button button-secondary button-small" onClick={deleteMessage}><Trash2 size={14}/>Delete message</button></div></>}</>}
        </article></div></section>}
  </main>;
}
function InfoNotice({ children }: { children: ReactNode }) { return <p className="tm-hint">{children}</p>; }
