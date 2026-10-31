import React, { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import WebApp from "@twa-dev/sdk";
import { api, message, money, queryClient, trpc } from "./api";
import { photoError, photoType } from "./image";
import { useNavigation } from "./store";
import "./style.css";

function Notice({ error }: { error: unknown }) {
  return error ? <p className="notice" role="alert">{message(error)}</p> : null;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

function useAction<T>(run: (input: T) => Promise<unknown>) {
  return useMutation({ mutationFn: run, onSuccess: () => queryClient.invalidateQueries() });
}

function Lists({ userId }: { userId?: string }) {
  const go = useNavigation((s) => s.go);
  const lists = useQuery(trpc.wishlists.list.queryOptions({ userId }));
  const create = useAction((input: { title: string; visibility: "public" | "private" }) => api.wishlists.create.mutate(input));
  const [title, setTitle] = useState("");
  return <section>
    <div className="section-heading"><h2>{userId ? "Their wishlists" : "Your wishlists"}</h2><span>{lists.data?.length || 0} lists</span></div>
    <Notice error={lists.error} />
    {lists.isPending && <p role="status">Loading wishlists…</p>}
    {lists.data?.length === 0 && <Empty>{userId ? "No wishlists to show." : "Make room for something you would love."}</Empty>}
    <div className="cards">{lists.data?.map(({ wishlist: w, ...counts }) => <button className="list-card" key={w.id} onClick={() => go({ kind: "wishlist", wishlistId: w.id })}>
      <span className="list-emoji">{w.emoji || "✦"}</span><strong>{w.title}</strong><span>{w.visibility} · {"itemCount" in counts ? String(counts.itemCount) : "View"} wishes</span>
    </button>)}</div>
    {!userId && <form onSubmit={(e) => { e.preventDefault(); create.mutate({ title: title.trim(), visibility: new FormData(e.currentTarget).get("visibility") as "public" | "private" }, { onSuccess: () => setTitle("") }); }}>
      <h3>A new wishlist</h3><label>Name<input required maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For the next adventure" /></label>
      <label>Who can see it<select name="visibility"><option value="public">Anyone with the link</option><option value="private">Accepted followers</option></select></label>
      <button disabled={create.isPending || !title.trim()}>Create wishlist</button><Notice error={create.error} />
    </form>}
  </section>;
}

function Profile({ userId }: { userId: string }) {
  const profile = useQuery({ queryKey: ["profile", userId], queryFn: () => api.users.profile.query({ userId }) });
  const request = useAction(() => api.follows.follow.mutate({ userId }));
  const unfollow = useAction(() => api.follows.unfollow.mutate({ userId }));
  if (!profile.data) return <><Notice error={profile.error} /><p role="status">{profile.isPending ? "Loading profile…" : "Profile unavailable."}</p></>;
  const p = profile.data;
  return <><section className="hero"><span className="eyebrow">A little inspiration</span><h1>{p.user.firstName}'s wishes</h1><p>{p.user.bio || "Good things are better together."}</p><span>{p.counts.followers} followers · {p.counts.wishlists} wishlists</span>{!p.isMe && <button disabled={request.isPending || unfollow.isPending} onClick={() => (p.followStatus === "pending" || p.followStatus === "accepted" ? unfollow : request).mutate()}>{p.followStatus === "accepted" ? "Unfollow" : p.followStatus === "pending" ? "Cancel follow request" : "Request to follow"}</button>}<Notice error={request.error || unfollow.error} /></section><Lists userId={userId} /></>;
}

function Wishlist({ wishlistId }: { wishlistId: string }) {
  const go = useNavigation((s) => s.go);
  const list = useQuery({ queryKey: ["wishlist", wishlistId], queryFn: () => api.wishlists.get.query({ wishlistId }) });
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoMessage, setPhotoMessage] = useState("");
  const [linkMessage, setLinkMessage] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const add = useAction(async (input: { title: string; description?: string; url?: string; priceMinor: number; currency: string; photo: File | null }) => {
    let imageUrl: string | undefined;
    if (input.photo) {
      const contentType = photoType(input.photo);
      if (!contentType) throw new Error("Use a JPEG, PNG, or WebP photo.");
      const signed = await api.products.presignImage.mutate({ contentType, contentLength: input.photo.size });
      const uploaded = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: input.photo,
      });
      if (!uploaded.ok) throw new Error("Unable to upload the photo. Check your connection and try again.");
      imageUrl = signed.publicUrl;
    }
    await api.products.create.mutate({
      wishlistId,
      title: input.title,
      description: input.description,
      url: input.url,
      imageUrl,
      priceMinor: input.priceMinor,
      currency: input.currency,
    });
  });
  useEffect(() => {
    if (!photo) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(photo);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  if (!list.data) return <><Notice error={list.error} /><p role="status">{list.isPending ? "Loading wishes…" : "Wishlist unavailable."}</p></>;
  const { wishlist: w, products, isOwner } = list.data;
  function choosePhoto(file: File | null, input: HTMLInputElement) {
    const problem = file ? photoError(file) : null;
    if (problem) {
      input.value = "";
      setPhoto(null);
      setPhotoMessage(problem);
      return;
    }
    setPhoto(file);
    setPhotoMessage("");
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const currency = String(data.get("currency"));
    const description = String(data.get("description") ?? "").trim();
    const url = String(data.get("url") ?? "").trim();
    if (url && !/^https?:\/\//i.test(url)) {
      setLinkMessage("Use a product link that starts with https://.");
      return;
    }
    setLinkMessage("");
    add.mutate({
      title: String(data.get("title")).trim(),
      description: description || undefined,
      url: url || undefined,
      priceMinor: Math.round(Number(data.get("price")) * (currency === "XTR" ? 1 : 100)),
      currency,
      photo,
    }, {
      onSuccess: () => { form.reset(); setPhoto(null); setPhotoMessage(""); setLinkMessage(""); },
    });
  }
  return <><section className="hero"><span className="eyebrow">{w.visibility} wishlist</span><h1>{w.emoji} {w.title}</h1><p>{w.description || "One wish at a time."}</p></section>
    <section><h2>The wishes</h2>{!products.length && <Empty>This list is waiting for its first wish.</Empty>}<div className="cards">{products.map((p) => <button className="list-card" key={p.id} onClick={() => go({ kind: "product", productId: p.id })}>{p.imageUrl && <img className="wish-photo" src={p.imageUrl} alt="" />}<strong>{p.title}</strong><span>{money(p.fundedMinor, p.currency)} of {money(p.priceMinor, p.currency)}</span><progress aria-label={`${p.title} funding`} value={Math.min(p.fundedMinor, p.priceMinor)} max={p.priceMinor} /></button>)}</div>
    {isOwner && <form onSubmit={submit}><h3>Add a wish</h3><label>What is it?<input name="title" required maxLength={200} /></label><label>Details<input name="description" maxLength={2000} /></label><label>Product link<input name="url" type="url" inputMode="url" maxLength={2048} placeholder="https://" aria-invalid={linkMessage ? true : undefined} aria-describedby={linkMessage ? "link-error" : undefined} /></label>{linkMessage && <p id="link-error" className="notice" role="alert">{linkMessage}</p>}<label>Photo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" aria-invalid={photoMessage ? true : undefined} aria-describedby={photoMessage ? "photo-error" : undefined} onChange={(e) => choosePhoto(e.target.files?.[0] ?? null, e.currentTarget)} /></label>{previewUrl && <img className="photo-preview" src={previewUrl} alt="" />}{photoMessage && <p id="photo-error" className="notice" role="alert">{photoMessage}</p>}<div className="fields"><label>Price<input name="price" type="number" min="0.01" step="0.01" required /></label><label>Currency<select name="currency"><option>USD</option><option>EUR</option><option>XTR</option></select></label></div><button disabled={add.isPending}>Add wish</button><Notice error={add.error} /></form>}</section></>;
}

function Product({ productId, sessionId, collecting = true }: { productId: string; sessionId?: string; collecting?: boolean }) {
  const product = useQuery({ queryKey: ["product", productId], queryFn: () => api.products.get.query({ productId }) });
  const history = useQuery({ queryKey: ["contributions", productId], queryFn: () => api.contributions.listForProduct.query({ productId, limit: 30 }) });
  const [amount, setAmount] = useState("100");
  const [mode, setMode] = useState<"stars" | "manual">("stars");
  const [anonymous, setAnonymous] = useState(false);
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState("");
  const quote = useQuery({ queryKey: ["quote", productId, amount], queryFn: () => api.contributions.quote.query({ productId, stars: Number(amount) }), enabled: mode === "stars" && Number.isInteger(Number(amount)) && Number(amount) > 0 });
  const pay = useAction(async () => {
    const extras = { productId, groupSessionId: sessionId, message: note, isAnonymous: anonymous };
    if (mode === "manual") {
      await api.contributions.declareManual.mutate({ ...extras, amountMinor: Math.round(Number(amount) * (product.data?.product.currency === "XTR" ? 1 : 100)) });
      setReceipt("Sent for the wishlist owner's confirmation. This is not a confirmed payment.");
    } else {
      const invoice = await api.contributions.createStarsInvoice.mutate({ ...extras, stars: Number(amount) });
      WebApp.openInvoice(invoice.invoiceLink, (status) => {
        setReceipt(status === "paid" ? "Payment submitted. Funding updates after Telegram confirms it." : status === "cancelled" ? "Payment cancelled. Nothing has been confirmed." : "Payment is not yet confirmed.");
        void queryClient.invalidateQueries();
      });
    }
  });
  if (!product.data) return <><Notice error={product.error} /><p role="status">{product.isPending ? "Loading wish…" : "Wish unavailable."}</p></>;
  const { product: p, isOwner } = product.data;
  return <><section className="hero"><span className="eyebrow">{product.data.wishlist.title}</span>{p.imageUrl && <img className="wish-photo" src={p.imageUrl} alt="" />}<h1>{p.title}</h1><p>{p.description}</p><div className="amount">{money(p.fundedMinor, p.currency)} <small>of {money(p.priceMinor, p.currency)}</small></div><progress aria-label="Funding progress" value={Math.min(p.fundedMinor, p.priceMinor)} max={p.priceMinor} /><p>{product.data.contributorCount} contributors · {p.status}</p></section>
    {!isOwner && collecting && p.status === "active" && <section><form onSubmit={(e) => { e.preventDefault(); setReceipt(""); pay.mutate(); }}><h2>Be part of this wish</h2><label>Contribution method<select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setAmount("100"); }}><option value="stars">Telegram Stars</option><option value="manual">Manual payment confirmation</option></select></label><label>{mode === "stars" ? "Stars" : `Amount (${p.currency})`}<input type="number" min={mode === "stars" || p.currency === "XTR" ? "1" : "0.01"} step={mode === "stars" || p.currency === "XTR" ? "1" : "0.01"} required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>{mode === "stars" && quote.data && <p>Credits {quote.data.formatted} toward this wish.</p>}<Notice error={quote.error} /><label>Message<input maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} /></label><label className="check"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />Keep my name anonymous</label><button disabled={pay.isPending || Number(amount) <= 0}>{pay.isPending ? "Preparing…" : mode === "stars" ? "Continue in Telegram" : "Request owner confirmation"}</button><Notice error={pay.error} /><p role="status">{receipt}</p></form></section>}
    <section><h2>Contributions</h2><Notice error={history.error} />{history.data?.items.length === 0 && <Empty>No contributions yet.</Empty>}{history.data?.items.map((c) => <article className="request" key={c.id}><strong>{money(c.amountMinor, c.currency)}</strong><p>{c.contributor?.firstName || "Anonymous"} · {c.status.replaceAll("_", " ")}</p>{c.message && <p>{c.message}</p>}</article>)}{history.data?.nextCursor && <p>Showing the 30 most recent contributions.</p>}</section></>;
}

function Requests() {
  const requests = useQuery({ queryKey: ["requests"], queryFn: () => api.follows.incomingRequests.query() });
  const respond = useAction((input: { followerId: string; accept: boolean }) => api.follows.respond.mutate(input));
  const pending = useQuery({ queryKey: ["pending"], queryFn: () => api.contributions.awaitingMyDecision.query() });
  const decide = useAction((input: { contributionId: string; decision: "confirm" | "reject" }) => api.contributions.decide.mutate(input));
  return <><section className="hero"><span className="eyebrow">Your circle</span><h1>Requests</h1><p>You decide who sees your private wishes.</p></section><section><h2>Follow requests</h2><Notice error={requests.error || respond.error} />{requests.data?.length === 0 && <Empty>You're all caught up.</Empty>}{requests.data?.map(({ user }) => <article className="request" key={user.id}><strong>{user.firstName}</strong><div className="actions"><button disabled={respond.isPending} onClick={() => respond.mutate({ followerId: user.id, accept: true })}>Accept</button><button className="secondary" disabled={respond.isPending} onClick={() => respond.mutate({ followerId: user.id, accept: false })}>Decline</button></div></article>)}</section><section><h2>Payment confirmations</h2><Notice error={pending.error || decide.error} />{pending.data?.length === 0 && <Empty>No manual payments waiting.</Empty>}{pending.data?.map((c) => <article className="request" key={c.id}><strong>{money(c.amountMinor, c.currency)}</strong><p>{c.message || "Manual payment"}</p><div className="actions"><button disabled={decide.isPending} onClick={() => decide.mutate({ contributionId: c.id, decision: "confirm" })}>Confirm received</button><button className="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ contributionId: c.id, decision: "reject" })}>Reject</button></div></article>)}</section></>;
}

function Session({ sessionId }: { sessionId: string }) {
  const session = useQuery({ queryKey: ["session", sessionId], queryFn: () => api.groupSessions.get.query({ sessionId }) });
  if (!session.data) return <><Notice error={session.error} /><p role="status">Loading group gift…</p></>;
  return <><p className="session-label">Group gift · {session.data.chatTitle} · {session.data.session.status}</p>{session.data.product ? <Product productId={session.data.product.id} sessionId={sessionId} collecting={session.data.session.status === "open"} /> : <Empty>The group is still choosing a wish.</Empty>}</>;
}

function Settings() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.users.me.query() });
  const update = useAction((input: { notificationsEnabled?: boolean; autoAcceptFollows?: boolean }) => api.users.updateMe.mutate(input));
  return <section><h1>Your profile</h1><Notice error={me.error || update.error} />{me.data && <><h2>{me.data.user.firstName}</h2><p>Current plan: {me.data.plan}</p><label className="check"><input type="checkbox" checked={me.data.user.notificationsEnabled} disabled={update.isPending} onChange={(e) => update.mutate({ notificationsEnabled: e.target.checked })} />Send notifications</label><label className="check"><input type="checkbox" checked={me.data.user.autoAcceptFollows} disabled={update.isPending} onChange={(e) => update.mutate({ autoAcceptFollows: e.target.checked })} />Automatically accept followers</label><p>Automatic acceptance lets new followers see your private wishlists.</p><button className="secondary" onClick={() => WebApp.showAlert("Premium upgrade is not available yet. Contact the bot owner for help.")}>Review upgrade options</button></>}</section>;
}

function App() {
  const { route, history, go, back } = useNavigation();
  const routed = useRef(false);
  const session = useQuery({ queryKey: ["session-bootstrap"], queryFn: () => api.auth.session.mutate(), enabled: Boolean(WebApp.initData), staleTime: Infinity });
  useEffect(() => { WebApp.ready(); WebApp.expand(); }, []);
  useEffect(() => {
    if (session.data?.startParam && !routed.current) {
      routed.current = true;
      go(session.data.startParam);
    }
  }, [session.data, go]);
  useEffect(() => {
    if (history.length) WebApp.BackButton.show(); else WebApp.BackButton.hide();
    WebApp.BackButton.onClick(back);
    return () => { WebApp.BackButton.offClick(back); };
  }, [history.length, back]);
  if (!WebApp.initData) return <main><section className="hero"><span className="eyebrow">A gift, together</span><h1>Make a little wish.</h1><p>Open this Mini App from its Telegram bot to see your wishlists securely.</p></section></main>;
  return <><header><button className="brand" onClick={() => go({ kind: "home" })}>✦ Wishlists</button>{history.length > 0 && <button className="secondary" onClick={back}>Back</button>}</header><main><Notice error={session.error} />{session.isPending ? <p role="status">Opening your wishlists…</p> : session.data && <>
    {route.kind === "home" && <><section className="hero"><span className="eyebrow">A gift, together</span><h1>Make a little wish.</h1><p>Collect the things you love.<br />Let your people be part of them.</p></section><Lists /></>}
    {route.kind === "user" && <Profile userId={route.userId} />}
    {route.kind === "wishlist" && <Wishlist wishlistId={route.wishlistId} />}
    {route.kind === "product" && <Product productId={route.productId} sessionId={route.sessionId} />}
    {route.kind === "requests" && <Requests />}
    {route.kind === "session" && <Session sessionId={route.sessionId} />}
    {route.kind === "settings" && <Settings />}
  </>}</main><nav aria-label="Main navigation">{(["home", "requests", "settings"] as const).map((kind) => <button key={kind} aria-current={route.kind === kind ? "page" : undefined} onClick={() => go({ kind })}>{kind === "home" ? "Wishlists" : kind === "requests" ? "Requests" : "Profile"}</button>)}</nav></>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></React.StrictMode>);
