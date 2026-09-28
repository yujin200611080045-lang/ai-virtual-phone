"use client";

// 网络：记忆之间的关系网（Ombre 后台的 Network）。越像的离得越近、连线越粗；颜色是情绪，大小是权重。

import { useMemo, useState } from "react";
import type { MemoryEntry } from "@/lib/memory-types";
import { cosineSimilarity } from "@/lib/memory-embedding";
import { isArchivedMemory, memKind, ombreScore } from "@/lib/memory-ombre";
import { tokenizeForSearch } from "@/lib/memory-hybrid";

type Props = {
    entries: MemoryEntry[];
    openEntry: (id: string) => void;
};

type Node = { e: MemoryEntry; x: number; y: number; vx: number; vy: number; r: number };
type Edge = { a: number; b: number; s: number };

const W = 360;
const H = 420;
const MAX_NODES = 140;

function valenceFill(e: MemoryEntry): string {
    const kind = memKind(e);
    if (kind === "feel") return "#b58cf0";
    if (kind === "plan") return "#4aa3df";
    if (kind === "letter") return "#e07ab1";
    if (kind === "i") return "#7a6ff0";
    const v = typeof e.valence === "number" ? e.valence : 0;
    if (v >= 0.2) return "#3aa76d";
    if (v <= -0.2) return "#d9534f";
    return "#9aa0aa";
}

function gramSet(e: MemoryEntry): Set<string> {
    return new Set(tokenizeForSearch(`${e.title || ""} ${(e.tags || []).join(" ")} ${e.content.slice(0, 600)}`).filter(t => t.length > 1 || /[a-z0-9]/.test(t)));
}

function similarity(a: MemoryEntry, b: MemoryEntry, ga: Set<string>, gb: Set<string>): number {
    if (a.embedding && b.embedding && a.embedding.length && a.embedding.length === b.embedding.length) {
        // 向量相似度整体偏高，拉开一点
        return Math.max(0, (cosineSimilarity(a.embedding, b.embedding) - 0.55) / 0.45);
    }
    if (ga.size === 0 || gb.size === 0) return 0;
    let inter = 0;
    for (const g of ga) if (gb.has(g)) inter++;
    return ((2 * inter) / (ga.size + gb.size)) * 1.6;
}

function layout(entries: MemoryEntry[]): { nodes: Node[]; edges: Edge[] } {
    const now = Date.now();
    const pool = entries
        .filter(e => !isArchivedMemory(e) && memKind(e) !== "letter")
        .sort((a, b) => ombreScore(b, now) - ombreScore(a, now))
        .slice(0, MAX_NODES);
    const n = pool.length;
    const grams = pool.map(gramSet);
    // 每个点取最像的 3 个邻居（相似度过门槛）
    const edgeMap = new Map<string, Edge>();
    for (let i = 0; i < n; i++) {
        const sims: Array<[number, number]> = [];
        for (let j = 0; j < n; j++) if (i !== j) sims.push([j, similarity(pool[i], pool[j], grams[i], grams[j])]);
        sims.sort((a, b) => b[1] - a[1]);
        for (const [j, s] of sims.slice(0, 3)) {
            if (s < 0.28) break;
            const key = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (!edgeMap.has(key)) edgeMap.set(key, { a: Math.min(i, j), b: Math.max(i, j), s: Math.min(1, s) });
        }
    }
    const edges = [...edgeMap.values()];
    // 确定性初始位置（按 id 散列），力导向迭代
    const hash = (str: string) => { let h = 2166136261; for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
    const nodes: Node[] = pool.map(e => {
        const sc = ombreScore(e, now);
        const r = sc >= 999 ? 9 : sc >= 50 ? 6 : 4 + Math.min(6, Math.sqrt(Math.max(0, sc)) * 1.6);
        return { e, x: W / 2 + (hash(e.id) - 0.5) * W * 0.8, y: H / 2 + (hash(e.id + "y") - 0.5) * H * 0.8, vx: 0, vy: 0, r };
    });
    const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.55;
    for (let it = 0; it < 260; it++) {
        const t = 1 - it / 260;
        for (let i = 0; i < n; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < n; j++) {
                const b = nodes[j];
                let dx = a.x - b.x, dy = a.y - b.y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02; }
                const f = (k * k) / d2 * 0.9;
                a.vx += dx * f * 0.02; a.vy += dy * f * 0.02;
                b.vx -= dx * f * 0.02; b.vy -= dy * f * 0.02;
            }
        }
        for (const ed of edges) {
            const a = nodes[ed.a], b = nodes[ed.b];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
            const f = ((d - k * (1.1 - ed.s * 0.6)) / d) * 0.06 * (0.5 + ed.s);
            a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
        for (const nd of nodes) {
            nd.vx += (W / 2 - nd.x) * 0.004; nd.vy += (H / 2 - nd.y) * 0.004;
            const cap = 12 * t + 0.5;
            nd.vx = Math.max(-cap, Math.min(cap, nd.vx)); nd.vy = Math.max(-cap, Math.min(cap, nd.vy));
            nd.x += nd.vx; nd.y += nd.vy; nd.vx *= 0.6; nd.vy *= 0.6;
        }
    }
    // 缩放进画布
    if (n > 0) {
        const xs = nodes.map(p => p.x), ys = nodes.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const pad = 16;
        const sx = (W - pad * 2) / Math.max(1, maxX - minX), sy = (H - pad * 2) / Math.max(1, maxY - minY);
        const s = Math.min(sx, sy, 2.5);
        const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
        for (const p of nodes) { p.x = ox + (p.x - minX) * s; p.y = oy + (p.y - minY) * s; }
    }
    return { nodes, edges };
}

export function MemoryNetworkTab({ entries, openEntry }: Props) {
    const { nodes, edges } = useMemo(() => layout(entries), [entries]);
    const [sel, setSel] = useState<number | null>(null);
    const neighbors = useMemo(() => {
        if (sel === null) return new Set<number>();
        const s = new Set<number>([sel]);
        for (const e of edges) { if (e.a === sel) s.add(e.b); if (e.b === sel) s.add(e.a); }
        return s;
    }, [sel, edges]);
    const selected = sel !== null ? nodes[sel] : null;

    if (nodes.length < 2) {
        return <div className="ts-12 text-secondary" style={{ background: "var(--c-card, #fff)", borderRadius: 14, padding: 14 }}>记忆还太少，织不成网。</div>;
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 130 }}>
            <div className="ts-12 text-secondary" style={{ flexShrink: 0, lineHeight: 1.7 }}>
                越像的记忆离得越近、连线越粗；点越大权重越高。绿=开心 红=难过 灰=平静 紫=感受/自我认识 蓝=计划。{entries.some(e => e.embedding?.length) ? "" : "（没开向量时按文字相似度连线，会比较稀疏）"}
            </div>
            <div style={{ background: "var(--c-card, #fff)", borderRadius: 14, flexShrink: 0, overflow: "hidden" }}>
                <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", touchAction: "manipulation" }} onClick={() => setSel(null)}>
                    {edges.map((ed, i) => {
                        const a = nodes[ed.a], b = nodes[ed.b];
                        const lit = sel !== null && (ed.a === sel || ed.b === sel);
                        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={lit ? "#e0a020" : "rgba(128,128,128,0.35)"} strokeWidth={lit ? 1.6 : 0.4 + ed.s * 1.4} opacity={sel === null || lit ? 1 : 0.25} />;
                    })}
                    {nodes.map((p, i) => {
                        const dim = sel !== null && !neighbors.has(i);
                        return (
                            <g key={p.e.id} opacity={dim ? 0.25 : 1} onClick={ev => { ev.stopPropagation(); setSel(i === sel ? null : i); }} style={{ cursor: "pointer" }}>
                                <circle cx={p.x} cy={p.y} r={p.r + 6} fill="transparent" />
                                <circle cx={p.x} cy={p.y} r={p.r} fill={valenceFill(p.e)} stroke={p.e.pinned ? "#e0a020" : i === sel ? "#333" : "#fff"} strokeWidth={p.e.pinned || i === sel ? 2 : 1} />
                                {p.e.anchored && <text x={p.x} y={p.y - p.r - 2} fontSize="8" textAnchor="middle">⚓</text>}
                            </g>
                        );
                    })}
                    {selected && (
                        <text x={Math.min(W - 6, Math.max(6, selected.x))} y={selected.y + selected.r + 12} fontSize="10" textAnchor={selected.x > W * 0.7 ? "end" : selected.x < W * 0.3 ? "start" : "middle"} fill="currentColor" style={{ paintOrder: "stroke", stroke: "var(--c-card, #fff)", strokeWidth: 3 }}>
                            {(selected.e.title || selected.e.content).slice(0, 14)}
                        </text>
                    )}
                </svg>
            </div>
            {selected && (
                <div style={{ background: "var(--c-card, #fff)", borderRadius: 14, padding: "12px 14px", flexShrink: 0 }}>
                    <div className="ts-13" style={{ fontWeight: 700 }}>{selected.e.title || "（无标题）"}</div>
                    <div className="ts-12" style={{ marginTop: 4, lineHeight: 1.7 }}>{selected.e.content.length > 120 ? selected.e.content.slice(0, 120) + "…" : selected.e.content}</div>
                    <div className="ts-11 text-secondary" style={{ marginTop: 6 }}>连着 {neighbors.size - 1} 条记忆</div>
                    <button className="ts-12" style={{ marginTop: 8, padding: "4px 12px", borderRadius: 999, border: "1px solid var(--c-border, rgba(0,0,0,0.12))", background: "transparent", color: "var(--c-text, #333)" }} onClick={() => openEntry(selected.e.id)}>
                        在记忆里打开
                    </button>
                </div>
            )}
            <div className="ts-11 text-secondary" style={{ flexShrink: 0 }}>显示权重最高的 {nodes.length} 条（归档和信不在网里）。</div>
        </div>
    );
}
