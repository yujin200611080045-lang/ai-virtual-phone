"use client";

// 流水：原始事件（短期 + 共享事件合并）/ 导入历史聊天 / 操作日志

import { useMemo, useRef, useState } from "react";
import { Upload, Zap, MoreHorizontal, ArrowLeft } from "lucide-react";
import { glassCard, ghostBtn, pill, barTrack, barFill } from "./memory-ui";
import type { NativeTimelineEntry } from "@/lib/short-term-assembler";
import { MemoryTimeline } from "./memory-timeline";
import { extractFromEvents, hasMemoryLLM, loadMemoryLog, chunkText } from "@/lib/memory-ombre";

type Section = "stream" | "import" | "log";

type Props = {
    characterId: string;
    userName: string;
    events: NativeTimelineEntry[];
    extracting: boolean;
    onExtractNow: () => void;
    reload: () => Promise<void>;
    notice: (msg: string) => void;
    openEntry: (id: string) => void;
};

const SOURCE_LABELS: Record<string, string> = {
    chat: "聊天", group_chat: "群聊", story: "剧情", moments: "朋友圈", checkphone: "查手机",
    diary: "日记", xiaohongshu: "小红书", interview_magazine: "访谈", cocreate: "共创",
    game: "小游戏", vn: "漫卷", adventure: "地图冒险", custom_app: "自定义应用",
};

const card = glassCard;
const btn = ghostBtn;

/** 把各家导出的 JSON 摊平成「说话人：内容」逐行文本。认 role/sender/author/name + content/text/message/parts。 */
function flattenJson(value: unknown, out: string[] = [], depth = 0): string[] {
    if (depth > 12 || value == null) return out;
    if (Array.isArray(value)) { for (const v of value) flattenJson(v, out, depth + 1); return out; }
    if (typeof value !== "object") return out;
    const o = value as Record<string, unknown>;
    const who = o.role ?? o.sender ?? (typeof o.author === "object" && o.author ? (o.author as Record<string, unknown>).role : o.author) ?? o.name;
    let text: unknown = o.content ?? o.text ?? o.message;
    if (text && typeof text === "object" && !Array.isArray(text)) {
        const t = text as Record<string, unknown>;
        text = Array.isArray(t.parts) ? t.parts.filter(p => typeof p === "string").join("\n") : t.text;
    }
    if (Array.isArray(text)) text = text.map(p => (typeof p === "string" ? p : typeof p === "object" && p && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, unknown>).text : "")).join("\n");
    if (typeof text === "string" && text.trim() && typeof who === "string") {
        out.push(`${who}：${text.trim()}`);
        return out;
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") flattenJson(v, out, depth + 1);
    return out;
}

function fmtTime(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function MemoryStreamTab({ characterId, userName, events, extracting, onExtractNow, reload, notice, openEntry }: Props) {
    const [section, setSection] = useState<Section>("stream");
    const [source, setSource] = useState<string>("all");
    const [importText, setImportText] = useState("");
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [importResult, setImportResult] = useState<string | null>(null);
    const signal = useRef({ cancelled: false });
    const [logTick, setLogTick] = useState(0);
    const [menuOpen, setMenuOpen] = useState(false);

    const sources = useMemo(() => {
        const m = new Map<string, number>();
        for (const e of events) m.set(e.sourceApp, (m.get(e.sourceApp) || 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    }, [events]);
    const shown = useMemo(() => (source === "all" ? events : events.filter(e => e.sourceApp === source)), [events, source]);
    const log = useMemo(() => { void logTick; return loadMemoryLog(characterId).slice().reverse(); }, [characterId, logTick, section]);

    const onFile = async (file: File) => {
        const raw = await file.text();
        let text = raw;
        if (/\.json$/i.test(file.name) || /^\s*[[{]/.test(raw)) {
            try {
                const lines = flattenJson(JSON.parse(raw));
                if (lines.length) text = lines.join("\n");
            } catch { /* 不是合法 JSON，按纯文本 */ }
        }
        setImportText(text);
        notice(`读入 ${file.name}，约 ${text.length} 字`);
    };

    const runImport = async () => {
        const text = importText.trim();
        if (!text) return;
        if (!hasMemoryLLM()) { notice("未配置记忆总结 API（绑定配置 → 辅助API绑定）"); return; }
        signal.current = { cancelled: false };
        setImportResult(null);
        setProgress({ done: 0, total: chunkText(text).length });
        try {
            const r = await extractFromEvents(characterId, text, {
                earliest: "导入的历史", latest: "导入的历史", origin: "import", sourceApp: "chat",
                metadata: { imported: true },
                signal: signal.current,
                onProgress: (done, total) => setProgress({ done, total }),
            });
            if ("error" in r) setImportResult(`失败：${r.error}`);
            else setImportResult(`${signal.current.cancelled ? "已停止。" : "导入完成。"}新记忆 ${r.created} 条，合并进旧记忆 ${r.merged} 条，计划 ${r.plans} 条。`);
            await reload();
            setLogTick(v => v + 1);
        } finally {
            setProgress(null);
        }
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 130 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, position: "relative" }}>
                {section === "stream" ? (
                    <span className="ts-12 text-secondary">当时的原话。记忆就是从这里提取出来的。</span>
                ) : (
                    <button className="ts-12" style={btn} onClick={() => setSection("stream")}><ArrowLeft size={12} /> 原始记录</button>
                )}
                <button className="ts-12" style={{ ...btn, padding: "5px 9px" }} aria-label="更多" onClick={() => setMenuOpen(v => !v)}><MoreHorizontal size={15} /></button>
                {menuOpen && (
                    <div style={{ ...glassCard, position: "absolute", right: 0, top: 36, zIndex: 20, padding: 6, display: "flex", flexDirection: "column", minWidth: 150, boxShadow: "0 8px 30px rgba(0,0,0,0.12)" }}>
                        {([["import", "导入以前的聊天"], ["log", "操作日志"]] as const).map(([k, l]) => (
                            <button key={k} className="ts-13" style={{ textAlign: "left", padding: "9px 10px", background: "transparent", border: "none", color: "var(--c-text, #111)", borderRadius: 10 }} onClick={() => { setSection(k); setMenuOpen(false); }}>{l}</button>
                        ))}
                    </div>
                )}
            </div>

            {section === "stream" && (
                <>
                    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <button className="ts-12" style={{ ...btn, flexShrink: 0 }} onClick={onExtractNow} disabled={extracting}>
                            <Zap size={12} /> {extracting ? "提取中…" : "现在提取"}
                        </button>
                    </div>
                    <div style={{ display: "flex", gap: 6, overflowX: "auto", flexShrink: 0, paddingBottom: 2, scrollbarWidth: "none" }}>
                        <button className="ts-11" style={pill(source === "all")} onClick={() => setSource("all")}>全部 {events.length}</button>
                        {sources.map(([k, n]) => (
                            <button key={k} className="ts-11" style={pill(source === k)} onClick={() => setSource(k)}>{SOURCE_LABELS[k] || k} {n}</button>
                        ))}
                    </div>
                    <MemoryTimeline events={shown} userName={userName} />
                </>
            )}

            {section === "import" && (
                <div style={card}>
                    <div className="ts-13" style={{ fontWeight: 700 }}>导入以前的聊天记录</div>
                    <div className="ts-11 text-secondary" style={{ marginTop: 4, lineHeight: 1.7 }}>
                        粘贴文字，或上传 .txt / .md / .json（ChatGPT、Claude 等导出的 JSON 会自动摊平成对话）。长内容会切成小块逐块提取，一点不丢；每块提取 0~5 条他第一人称的记忆，像的会合并进旧记忆。
                    </div>
                    <textarea
                        className="ui-textarea ts-12"
                        value={importText}
                        onChange={e => setImportText(e.target.value)}
                        placeholder={"小烬：今天考完试了\n我：辛苦了，想吃什么？"}
                        style={{ width: "100%", minHeight: 150, marginTop: 10 }}
                        disabled={Boolean(progress)}
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <label className="ts-12" style={{ ...btn, cursor: "pointer" }}>
                            <Upload size={12} /> 选文件
                            <input type="file" accept=".txt,.md,.json,text/plain,application/json" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
                        </label>
                        {progress ? (
                            <button className="ts-12" style={btn} onClick={() => { signal.current.cancelled = true; }}>停止</button>
                        ) : (
                            <button className="ts-12" style={btn} disabled={!importText.trim()} onClick={() => void runImport()}>开始导入</button>
                        )}
                        <span className="ts-11 text-secondary">{importText ? `${importText.length} 字 · ${chunkText(importText).length} 块` : ""}</span>
                    </div>
                    {progress && (
                        <div style={{ marginTop: 10 }}>
                            <div style={barTrack}><div style={barFill(progress.done / Math.max(1, progress.total))} /></div>
                            <div className="ts-11 text-secondary" style={{ marginTop: 4 }}>正在读第 {Math.min(progress.total, progress.done + 1)} / {progress.total} 块…</div>
                        </div>
                    )}
                    {importResult && <div className="ts-12" style={{ marginTop: 10 }}>{importResult}</div>}
                </div>
            )}

            {section === "log" && (
                <>
                    <div className="ts-12 text-secondary" style={{ flexShrink: 0 }}>每条记忆是谁写的、什么时候合并、为什么归档（最近 300 条）。</div>
                    {log.length === 0 && <div style={card} className="ts-12 text-secondary">还没有记录。之后的新记忆、合并、归档都会记在这里。</div>}
                    {log.map((l, i) => (
                        <button
                            key={i}
                            onClick={() => l.id && openEntry(l.id)}
                            style={{ ...card, display: "block", width: "100%", textAlign: "left", border: "none", padding: "10px 14px", color: "var(--c-text, #333)" }}
                        >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                <span className="ts-12"><b>{l.op}</b>{l.title ? ` · ${l.title}` : ""}</span>
                                <span className="ts-11 text-secondary" style={{ whiteSpace: "nowrap" }}>{fmtTime(l.at)}</span>
                            </div>
                            <div className="ts-11 text-secondary" style={{ marginTop: 3 }}>{l.by}{l.detail ? ` · ${l.detail}` : ""}</div>
                        </button>
                    ))}
                </>
            )}
        </div>
    );
}
