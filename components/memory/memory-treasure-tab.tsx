"use client";

// 珍藏：计划 / 信 / 锚点 / 自我认识 / 感受（对应 Ombre 后台的 Plans / Letters / Anchors + I + feel）

import { useState } from "react";
import { Mail, MailOpen, Lock, Hourglass, Plus, X, Check, Anchor, Moon } from "lucide-react";
import type { MemoryEntry } from "@/lib/memory-types";
import { glass, glassCard, ghostBtn, pill } from "./memory-ui";
import {
    OMBRE_LIMITS,
    isArchivedMemory,
    letterIsReadable,
    memKind,
    releaseAnchor,
    runTreasureDigest,
    traceMemory,
    writeLetter,
    writePlan,
} from "@/lib/memory-ombre";

type Section = "plan" | "letter" | "anchor" | "self" | "feel";

type Props = {
    characterId: string;
    characterName: string;
    entries: MemoryEntry[];
    reload: () => Promise<void>;
    notice: (msg: string) => void;
    openEntry: (id: string) => void;
};

const ASPECT_LABEL: Record<string, string> = {
    nature: "我是什么样的", values: "我在乎什么", patterns: "我的习惯", limits: "我的边界",
    becoming: "我正在变成", uncertainty: "我还不确定", stance: "我的立场",
};

const card = glassCard;
const btn = ghostBtn;

function fmtDate(iso?: string): string {
    return iso ? iso.slice(0, 10) : "";
}

function daysUntil(iso?: string): number {
    if (!iso) return 0;
    return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
}

export function MemoryTreasureTab({ characterId, characterName, entries, reload, notice, openEntry }: Props) {
    const [section, setSection] = useState<Section>("plan");
    const [showDone, setShowDone] = useState(false);
    const [planDraft, setPlanDraft] = useState<string | null>(null);
    const [letterDraft, setLetterDraft] = useState<{ title: string; content: string; lock: "none" | "timed" | "permanent"; date: string } | null>(null);
    const [reading, setReading] = useState<MemoryEntry | null>(null);
    const [busy, setBusy] = useState(false);
    const [digesting, setDigesting] = useState(false);

    const digest = async () => {
        if (digesting) return;
        setDigesting(true);
        try {
            const r = await runTreasureDigest(characterId);
            if (r.error) { notice(r.error); return; }
            const parts = [
                r.feels && `写下 ${r.feels} 份感受`, r.pins && `钉了 ${r.pins} 条核心准则`, r.anchors && `设了 ${r.anchors} 个锚点`,
                r.resolved && `放下 ${r.resolved} 件事`, r.plansDone && `确认完成 ${r.plansDone} 个计划`, r.selves && `多了 ${r.selves} 条自我认识`,
            ].filter(Boolean);
            notice(parts.length ? `${characterName}整理完了：${parts.join("，")}` : `${characterName}看了一遍，这次没有要动的`);
            await reload();
        } finally {
            setDigesting(false);
        }
    };

    const live = entries.filter(e => !isArchivedMemory(e));
    const plans = live.filter(e => memKind(e) === "plan");
    const activePlans = plans.filter(e => (e.planStatus ?? "active") === "active").sort((a, b) => Number(Boolean(b.resolutionSuggestion)) - Number(Boolean(a.resolutionSuggestion)) || b.createdAt.localeCompare(a.createdAt));
    const donePlans = plans.filter(e => (e.planStatus ?? "active") !== "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const letters = live.filter(e => memKind(e) === "letter").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const anchors = live.filter(e => e.anchored);
    const selves = live.filter(e => memKind(e) === "i");
    const feels = live.filter(e => memKind(e) === "feel").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const byId = new Map(entries.map(e => [e.id, e]));

    const act = async (fn: () => Promise<unknown>, msg: string) => {
        if (busy) return;
        setBusy(true);
        try { await fn(); notice(msg); await reload(); } catch (err) { notice(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
    };

    const sections: Array<{ key: Section; label: string; n: number }> = [
        { key: "plan", label: "计划", n: activePlans.length },
        { key: "letter", label: "信", n: letters.length },
        { key: "anchor", label: "锚点", n: anchors.length },
        { key: "self", label: "自我认识", n: selves.filter(e => e.selfStatus === "promoted").length },
        { key: "feel", label: "感受", n: feels.length },
    ];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 130 }}>
            <div style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
                <span className="ts-12 text-secondary" style={{ flex: 1, lineHeight: 1.6 }}>
                    珍藏会自己长：每攒几批新记忆，{characterName}会回看一遍，自己决定钉什么、锚什么、写下什么感受、放下什么。
                </span>
                <button className="ts-12" style={{ ...btn, flexShrink: 0 }} disabled={digesting} onClick={() => void digest()}>
                    <Moon size={12} /> {digesting ? "整理中…" : "让他整理一下"}
                </button>
            </div>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", flexShrink: 0, paddingBottom: 2, scrollbarWidth: "none" }}>
                {sections.map(s => (
                    <button key={s.key} className="ts-12" style={pill(section === s.key)} onClick={() => setSection(s.key)}>{s.label} {s.n}</button>
                ))}
            </div>

            {/* ── 计划 ── */}
            {section === "plan" && (
                <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                        <span className="ts-12 text-secondary">他还惦记着的事。新记忆对上了会提示“可能已经完成”。</span>
                        <button className="ts-12" style={{ ...btn, flexShrink: 0 }} onClick={() => setPlanDraft("")}><Plus size={12} /> 帮他记</button>
                    </div>
                    {planDraft !== null && (
                        <div style={card}>
                            <textarea className="ui-textarea ts-12" value={planDraft} onChange={e => setPlanDraft(e.target.value)} placeholder="比如：周六陪她去看展" style={{ width: "100%", minHeight: 60 }} />
                            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                                <button className="ts-12" style={btn} onClick={() => setPlanDraft(null)}>取消</button>
                                <button className="ts-12" style={btn} disabled={!planDraft.trim() || busy} onClick={() => void act(async () => { await writePlan(characterId, { content: planDraft.trim() }, { origin: "user_manual" }); setPlanDraft(null); }, "计划已记下")}>记下</button>
                            </div>
                        </div>
                    )}
                    {activePlans.length === 0 && <div style={card} className="ts-12 text-secondary">现在没有进行中的计划。</div>}
                    {activePlans.map(p => (
                        <div key={p.id} style={{ ...card, border: p.resolutionSuggestion ? "1px solid var(--c-text, #111)" : card.border }}>
                            <div className="ts-13" style={{ fontWeight: 600, lineHeight: 1.6 }} onClick={() => openEntry(p.id)}>{p.content}</div>
                            <div className="ts-11 text-secondary" style={{ marginTop: 4 }}>{fmtDate(p.createdAt)} 记下</div>
                            {p.resolutionSuggestion && (
                                <div className="ts-12" style={{ marginTop: 8, padding: "8px 10px", borderRadius: 10, background: "color-mix(in srgb, var(--c-text, #111) 6%, transparent)", lineHeight: 1.6 }}>
                                    🔔 可能已经做到了{p.resolutionSuggestion.reason ? `：${p.resolutionSuggestion.reason}` : ""}
                                    {byId.get(p.resolutionSuggestion.byId) && <span className="text-secondary">（来自「{byId.get(p.resolutionSuggestion.byId)!.title || "一条新记忆"}」）</span>}
                                </div>
                            )}
                            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                                <button className="ts-12" style={btn} onClick={() => void act(() => traceMemory(characterId, p.id, { status: "done" }, "user"), "计划已完成")}><Check size={12} /> 完成了</button>
                                <button className="ts-12" style={btn} onClick={() => void act(() => traceMemory(characterId, p.id, { status: "dropped" }, "user"), "计划已放弃")}><X size={12} /> 不做了</button>
                            </div>
                        </div>
                    ))}
                    {donePlans.length > 0 && (
                        <button className="ts-12 text-secondary" style={{ ...btn, alignSelf: "flex-start", flexShrink: 0 }} onClick={() => setShowDone(v => !v)}>
                            {showDone ? "收起" : `已结束的计划 ${donePlans.length}`}
                        </button>
                    )}
                    {showDone && donePlans.map(p => (
                        <div key={p.id} style={{ ...card, opacity: 0.6 }}>
                            <div className="ts-12" style={{ textDecoration: p.planStatus === "done" ? "line-through" : undefined }}>{p.content}</div>
                            <div className="ts-11 text-secondary" style={{ marginTop: 4 }}>
                                {p.planStatus === "done" ? "已完成" : "已放弃"} · {fmtDate(p.updatedAt)}
                                <button className="ts-11" style={{ ...btn, marginLeft: 8, padding: "1px 8px" }} onClick={() => void act(() => traceMemory(characterId, p.id, { status: "active" }, "user"), "计划重新进行中")}>重新打开</button>
                            </div>
                        </div>
                    ))}
                </>
            )}

            {/* ── 信 ── */}
            {section === "letter" && (
                <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                        <span className="ts-12 text-secondary">信永久保存，不会淡掉，也不会被合并。</span>
                        <button className="ts-12" style={{ ...btn, flexShrink: 0 }} onClick={() => setLetterDraft({ title: "", content: "", lock: "none", date: "" })}><Mail size={12} /> 写给他</button>
                    </div>
                    {letters.length === 0 && <div style={card} className="ts-12 text-secondary">还没有信。他可以用 letter_write 写，你也可以写给他。</div>}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, flexShrink: 0 }}>
                        {letters.map(l => {
                            const lock = l.letterLock?.type ?? "none";
                            const readable = letterIsReadable(l);
                            const fromUser = l.metadata?.letterFrom === "user";
                            return (
                                <button
                                    key={l.id}
                                    onClick={() => readable ? setReading(l) : notice(lock === "permanent" ? "这封信永久封存着" : `还要 ${daysUntil(l.letterLock?.unlockAt)} 天才能拆`)}
                                    style={{ ...glass, position: "relative", aspectRatio: "1.45", padding: 12, textAlign: "left", color: "var(--c-text, #111)", overflow: "hidden", borderRadius: 12 }}
                                >
                                    <svg viewBox="0 0 100 60" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.18 }}>
                                        <polyline points="0,0 50,34 100,0" fill="none" stroke="currentColor" strokeWidth="0.6" />
                                    </svg>
                                    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-between" }}>
                                        <span className="ts-11" style={{ opacity: 0.7 }}>{fromUser ? `你 → ${characterName}` : `${characterName} →`} · {fmtDate(l.createdAt)}</span>
                                        <span className="ts-12" style={{ fontWeight: 700, lineHeight: 1.4 }}>{l.title}</span>
                                        <span className="ts-11" style={{ display: "flex", alignItems: "center", gap: 4, opacity: 0.75 }}>
                                            {lock === "permanent" ? <><Lock size={11} /> 永久封存</> : !readable ? <><Hourglass size={11} /> 还有 {daysUntil(l.letterLock?.unlockAt)} 天</> : <><MailOpen size={11} /> 可以拆</>}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}

            {/* ── 锚点 ── */}
            {section === "anchor" && (
                <>
                    <div className="ts-12 text-secondary" style={{ flexShrink: 0 }}>
                        重要到该成为参照系的事。锚点不衰减、不主动打扰，最多 {OMBRE_LIMITS.maxAnchors} 个（已用 {anchors.length}）。在「记忆」里点一条的 ··· 就能设为锚点。
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, flexShrink: 0 }}>
                        {Array.from({ length: OMBRE_LIMITS.maxAnchors }).map((_, i) => {
                            const a = anchors[i];
                            if (!a) return <div key={i} style={{ aspectRatio: "1", borderRadius: 12, border: "1px dashed var(--c-border, rgba(0,0,0,0.15))" }} />;
                            const reason = typeof a.metadata?.anchorReason === "string" ? a.metadata.anchorReason : "";
                            return (
                                <div key={a.id} style={{ ...glass, aspectRatio: "1", borderRadius: 12, padding: 8, display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden" }}>
                                    <button onClick={() => openEntry(a.id)} style={{ background: "transparent", border: "none", padding: 0, textAlign: "left", color: "var(--c-text, #333)" }}>
                                        <Anchor size={12} style={{ opacity: 0.6 }} />
                                        <div className="ts-11" style={{ fontWeight: 700, lineHeight: 1.35, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{a.title || a.content}</div>
                                    </button>
                                    <div className="ts-11 text-secondary" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</span>
                                        <button className="ts-11" style={{ background: "transparent", border: "none", padding: 0, color: "var(--c-text-secondary, #888)" }} onClick={() => void act(() => releaseAnchor(characterId, a.id, "user"), "已取消锚点")}>×</button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}

            {/* ── 自我认识 ── */}
            {section === "self" && (
                <>
                    <div className="ts-12 text-secondary" style={{ flexShrink: 0, lineHeight: 1.7 }}>
                        他用 I 写下的自我认识。先是候选，要在 {OMBRE_LIMITS.selfPromoteDreams} 个不同日子的 dream 里都还认同，才算确认；确认的最新 3 条每次对话都会带上。
                    </div>
                    {selves.length === 0 && <div style={card} className="ts-12 text-secondary">他还没有写下对自己的认识。</div>}
                    {selves.filter(e => e.selfStatus === "promoted").map(e => (
                        <div key={e.id} style={card}>
                            <div className="ts-11 text-secondary">✦ {ASPECT_LABEL[e.selfAspect || "nature"] || e.selfAspect} · 确认于 {fmtDate(e.updatedAt)}</div>
                            <div className="ts-13" style={{ marginTop: 4, lineHeight: 1.7 }}>{e.content}</div>
                        </div>
                    ))}
                    {selves.filter(e => e.selfStatus === "candidate").map(e => {
                        const n = e.selfWitnessDates?.length ?? 0;
                        return (
                            <div key={e.id} style={{ ...card, opacity: 0.85 }}>
                                <div className="ts-11 text-secondary">候选 · {ASPECT_LABEL[e.selfAspect || "nature"] || e.selfAspect}</div>
                                <div className="ts-12" style={{ marginTop: 4, lineHeight: 1.7 }}>{e.content}</div>
                                <div style={{ display: "flex", gap: 4, marginTop: 8, alignItems: "center" }}>
                                    {Array.from({ length: OMBRE_LIMITS.selfPromoteDreams }).map((_, i) => (
                                        <span key={i} style={{ width: 22, height: 5, borderRadius: 999, background: i < n ? "var(--c-text, #111)" : "color-mix(in srgb, var(--c-text, #111) 10%, transparent)" }} />
                                    ))}
                                    <span className="ts-11 text-secondary" style={{ marginLeft: 6 }}>被 dream 见证 {n}/{OMBRE_LIMITS.selfPromoteDreams}</span>
                                </div>
                            </div>
                        );
                    })}
                    {selves.some(e => e.selfStatus === "superseded") && (
                        <div className="ts-11 text-secondary" style={{ flexShrink: 0 }}>另有 {selves.filter(e => e.selfStatus === "superseded").length} 条旧认识已被新的取代。</div>
                    )}
                </>
            )}

            {/* ── 感受 ── */}
            {section === "feel" && (
                <>
                    <div className="ts-12 text-secondary" style={{ flexShrink: 0 }}>他写下的感受。感受不衰减，也不主动浮现，只有他用 feel 才会想起来。</div>
                    {feels.length === 0 && <div style={card} className="ts-12 text-secondary">还没有写下的感受。</div>}
                    {feels.map(f => {
                        const src = f.sourceBucketId ? byId.get(f.sourceBucketId) : undefined;
                        return (
                            <div key={f.id} style={card}>
                                <div className="ts-11 text-secondary">{fmtDate(f.createdAt)}</div>
                                <div className="ts-13" style={{ marginTop: 4, lineHeight: 1.7 }}>{f.content}</div>
                                {src && (
                                    <button className="ts-11 text-secondary" style={{ marginTop: 6, background: "transparent", border: "none", padding: 0 }} onClick={() => openEntry(src.id)}>
                                        ↳ 因为「{src.title || src.content.slice(0, 16)}」
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </>
            )}

            {/* 写信 */}
            {letterDraft && (
                <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => busy ? undefined : setLetterDraft(null)}>
                    <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={e => e.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <button className="modal-header-btn modal-header-btn-muted" onClick={() => setLetterDraft(null)} disabled={busy}><X size={18} /></button>
                            <h3 className="modal-title">写信给{characterName}</h3>
                            <button
                                className="modal-header-btn modal-header-btn-action"
                                disabled={busy || !letterDraft.content.trim() || (letterDraft.lock === "timed" && !letterDraft.date)}
                                onClick={() => void act(async () => {
                                    await writeLetter(characterId, {
                                        content: letterDraft.content.trim(),
                                        title: letterDraft.title.trim() || undefined,
                                        to: characterName,
                                        from: "user",
                                        lock: letterDraft.lock,
                                        unlockDate: letterDraft.date || undefined,
                                    }, { origin: "user_manual" });
                                    setLetterDraft(null);
                                }, "信寄出去了")}
                            ><Check size={18} /></button>
                        </div>
                        <div className="modal-body mem-edit-body" data-ui="modal-body">
                            <input className="ts-13" value={letterDraft.title} onChange={e => setLetterDraft({ ...letterDraft, title: e.target.value })} placeholder="标题（可不填）" style={{ width: "100%", padding: "8px 12px", borderRadius: 10, border: "1px solid var(--c-border, rgba(0,0,0,0.1))", background: "var(--c-input, rgba(0,0,0,0.03))", color: "var(--c-text, #333)", marginBottom: 8 }} />
                            <textarea className="ui-textarea mem-edit-textarea" value={letterDraft.content} onChange={e => setLetterDraft({ ...letterDraft, content: e.target.value })} placeholder="想对他说的话……" />
                            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                                {([["none", "直接能读"], ["timed", "到日子才能拆"], ["permanent", "永久封存"]] as const).map(([k, label]) => (
                                    <button key={k} className="ts-12" style={pill(letterDraft.lock === k)} onClick={() => setLetterDraft({ ...letterDraft, lock: k })}>{label}</button>
                                ))}
                                {letterDraft.lock === "timed" && (
                                    <input type="date" className="ts-12" value={letterDraft.date} onChange={e => setLetterDraft({ ...letterDraft, date: e.target.value })} style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid var(--c-border, rgba(0,0,0,0.1))" }} />
                                )}
                            </div>
                            <div className="ts-11 text-secondary" style={{ marginTop: 8, lineHeight: 1.6 }}>
                                {letterDraft.lock === "permanent" ? "永久封存：他只能看到标题，谁都拆不开。" : letterDraft.lock === "timed" ? "到那天之前，他只知道有这封信。" : "他用 letter_read 就能读到。"}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* 读信 */}
            {reading && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setReading(null)}>
                    <div onClick={e => e.stopPropagation()} style={{ ...glass, background: "color-mix(in srgb, var(--c-card, #fff) 88%, transparent)", width: "min(92vw, 420px)", maxHeight: "78vh", overflowY: "auto", padding: "22px 20px", color: "var(--c-text, #111)", boxShadow: "0 12px 40px rgba(0,0,0,0.18)" }}>
                        <div className="ts-11" style={{ opacity: 0.6 }}>{reading.metadata?.letterFrom === "user" ? `你写给${characterName}` : `${characterName} 写的信`} · {fmtDate(reading.createdAt)}</div>
                        <div className="ts-16" style={{ fontWeight: 700, margin: "6px 0 14px" }}>{reading.title}</div>
                        <div className="ts-13" style={{ whiteSpace: "pre-wrap", lineHeight: 1.9 }}>{reading.content}</div>
                    </div>
                </div>
            )}
        </div>
    );
}
