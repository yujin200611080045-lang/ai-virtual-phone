"use client";

// 浮现：模拟角色下一次开口前会浮上来的记忆（Ombre 的 Breath 模拟），外加「如果她说了……」试探检索

import { useMemo, useState } from "react";
import { Shuffle, Search, Eye, EyeOff } from "lucide-react";
import type { MemoryEntry, MemoryConfig } from "@/lib/memory-types";
import {
    formatSurfacedMemories,
    imp10,
    ombreScore,
    searchMemoriesOmbre,
    selectBreathSurface,
    surfaceSectionOf,
    type SearchHit,
    type SurfaceSection,
} from "@/lib/memory-ombre";

type Props = {
    characterId: string;
    entries: MemoryEntry[];
    coreEntries: MemoryEntry[];
    config: MemoryConfig;
    openEntry: (id: string) => void;
};

const SECTIONS: Array<{ key: SurfaceSection; label: string; hint: string }> = [
    { key: "pinned", label: "📌 核心准则", hint: "每次都在" },
    { key: "related", label: "此刻想起的", hint: "和当前聊天相关" },
    { key: "surfaced", label: "浮现的记忆", hint: "按权重，第一条固定、其余洗牌" },
    { key: "passive", label: "💤 久未浮现", hint: "很重要但很久没被想起" },
    { key: "serendipity", label: "✨ 偶遇", hint: "已放下的记忆偶尔回来" },
    { key: "self", label: "我对自己的认识", hint: "最新 3 条已确认的" },
    { key: "plan", label: "我还惦记着的事", hint: "进行中的计划" },
];

const DIM_LABEL: Record<string, string> = { topic: "关键词", bm25: "词频", semantic: "语义", emotion: "情绪", time: "时间", importance: "重要度" };

const card = { background: "var(--c-card, #fff)", borderRadius: 14, padding: "12px 14px" } as const;
const chip = { display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 12px", borderRadius: 999, border: "1px solid var(--c-border, rgba(0,0,0,0.1))", background: "transparent" } as const;

export function MemoryBreathTab({ characterId, entries, coreEntries, config, openEntry }: Props) {
    const [seed, setSeed] = useState(0);
    const [showRaw, setShowRaw] = useState(false);
    const [probe, setProbe] = useState("");
    const [hits, setHits] = useState<SearchHit[] | null>(null);
    const [probing, setProbing] = useState(false);

    const surfaced = useMemo(() => {
        void seed;
        return selectBreathSurface(entries, { maxResults: config.breathMaxResults ?? 20, tokenBudget: config.longTermTokenBudget });
    }, [entries, config.breathMaxResults, config.longTermTokenBudget, seed]);

    const runProbe = async () => {
        const q = probe.trim();
        if (!q) { setHits(null); return; }
        setProbing(true);
        try { setHits(await searchMemoriesOmbre(characterId, q, { limit: 8 }, entries)); } finally { setProbing(false); }
    };

    const now = Date.now();
    const activeCore = coreEntries.length;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 130 }}>
            <div className="ts-12 text-secondary" style={{ lineHeight: 1.7, flexShrink: 0 }}>
                下一次开口前，这些记忆会浮到他脑子里。浮现带随机，每次不完全一样。
                {activeCore > 0 ? ` 另外还有 ${activeCore} 条核心记忆会单独带上。` : ""}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button className="ts-12" style={chip} onClick={() => setSeed(v => v + 1)}>
                    <Shuffle size={13} />再抽一次
                </button>
                <button className="ts-12" style={chip} onClick={() => setShowRaw(v => !v)}>
                    {showRaw ? <EyeOff size={13} /> : <Eye size={13} />}
                    {showRaw ? "看分区" : "看他收到的原文"}
                </button>
            </div>

            {surfaced.length === 0 ? (
                <div style={card} className="ts-12 text-secondary">记忆池还是空的，聊一阵、或在「记忆」里新增一条就会有东西浮上来。</div>
            ) : showRaw ? (
                <pre className="ts-11" style={{ ...card, whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7, flexShrink: 0 }}>
                    {formatSurfacedMemories(surfaced, { withIds: false })}
                </pre>
            ) : (
                SECTIONS.map(sec => {
                    const list = surfaced.filter(e => surfaceSectionOf(e) === sec.key);
                    if (list.length === 0) return null;
                    return (
                        <div key={sec.key} style={{ ...card, flexShrink: 0 }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                                <span className="ts-13" style={{ fontWeight: 700 }}>{sec.label}</span>
                                <span className="ts-11 text-secondary">{sec.hint} · {list.length}</span>
                            </div>
                            {list.map(e => {
                                const s = ombreScore(e, now);
                                return (
                                    <button
                                        key={e.id}
                                        onClick={() => openEntry(e.id)}
                                        style={{ display: "flex", width: "100%", gap: 8, alignItems: "flex-start", textAlign: "left", padding: "7px 0", background: "transparent", border: "none", borderTop: "1px dashed var(--c-border, rgba(0,0,0,0.06))", color: "var(--c-text, #333)" }}
                                    >
                                        <span className="ts-12" style={{ flex: 1, lineHeight: 1.6 }}>
                                            {e.title ? <b>{e.title}：</b> : null}{e.content.length > 70 ? e.content.slice(0, 70) + "…" : e.content}
                                        </span>
                                        <span className="ts-11 text-secondary" style={{ whiteSpace: "nowrap" }}>{s >= 999 ? "∞" : s >= 50 ? "—" : s.toFixed(2)}</span>
                                    </button>
                                );
                            })}
                        </div>
                    );
                })
            )}

            <div style={{ ...card, flexShrink: 0, marginTop: 6 }}>
                <div className="ts-13" style={{ fontWeight: 700, marginBottom: 4 }}>如果她说了……</div>
                <div className="ts-11 text-secondary" style={{ marginBottom: 8 }}>输入一句话，看会勾起哪些记忆、每一项各贡献多少。检索不会把记忆标成“被想起”。</div>
                <div style={{ display: "flex", gap: 8 }}>
                    <input
                        value={probe}
                        onChange={e => setProbe(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") void runProbe(); }}
                        placeholder="比如：还记得我们上次吵架吗"
                        className="ts-12"
                        style={{ flex: 1, minWidth: 0, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--c-border, rgba(0,0,0,0.1))", background: "var(--c-input, rgba(0,0,0,0.03))", color: "var(--c-text, #333)" }}
                    />
                    <button className="ts-12" style={{ ...chip, flexShrink: 0 }} onClick={() => void runProbe()} disabled={probing}>
                        <Search size={13} /> {probing ? "…" : "试试"}
                    </button>
                </div>
                {hits && hits.length === 0 && <div className="ts-12 text-secondary" style={{ marginTop: 10 }}>什么都没勾起来。</div>}
                {hits && hits.map(h => (
                    <button
                        key={h.entry.id}
                        onClick={() => openEntry(h.entry.id)}
                        style={{ display: "block", width: "100%", textAlign: "left", marginTop: 10, paddingTop: 10, background: "transparent", border: "none", borderTop: "1px dashed var(--c-border, rgba(0,0,0,0.08))", color: "var(--c-text, #333)" }}
                    >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span className="ts-12" style={{ fontWeight: 600 }}>{h.entry.title || h.entry.content.slice(0, 20)}</span>
                            <span className="ts-11 text-secondary">匹配 {Math.round(h.dims.normalized ?? h.score)}{h.entry.resolved ? " · 已放下 ×0.3" : ""}</span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "3.5em 1fr", gap: "3px 8px", marginTop: 6, alignItems: "center" }}>
                            {Object.keys(DIM_LABEL).map(k => {
                                const v = Math.max(0, Math.min(1, h.dims[k] ?? 0));
                                return [
                                    <span key={k + "l"} className="ts-11 text-secondary">{DIM_LABEL[k]}</span>,
                                    <span key={k + "b"} style={{ height: 4, borderRadius: 999, background: "var(--c-input, rgba(0,0,0,0.07))", overflow: "hidden" }}>
                                        <span style={{ display: "block", height: "100%", width: `${Math.round(v * 100)}%`, background: k === "semantic" ? "#7a6ff0" : k === "topic" || k === "bm25" ? "#3aa76d" : "#e0a020", borderRadius: 999 }} />
                                    </span>,
                                ];
                            })}
                        </div>
                        <div className="ts-11 text-secondary" style={{ marginTop: 4 }}>重要度 {imp10(h.entry)}/10</div>
                    </button>
                ))}
            </div>
        </div>
    );
}
