// 记忆库统一视觉：黑白 + 毛玻璃磨砂，颜色只留给情绪
import type { CSSProperties } from "react";

export const glass: CSSProperties = {
    background: "color-mix(in srgb, var(--c-card, #fff) 62%, transparent)",
    backdropFilter: "blur(18px) saturate(140%)",
    WebkitBackdropFilter: "blur(18px) saturate(140%)",
    border: "0.5px solid color-mix(in srgb, var(--c-text, #111) 10%, transparent)",
    borderRadius: 16,
};

export const glassCard: CSSProperties = { ...glass, padding: "12px 14px", flexShrink: 0 };

export const pill = (on: boolean): CSSProperties => ({
    flexShrink: 0,
    whiteSpace: "nowrap",
    padding: "5px 12px",
    borderRadius: 999,
    lineHeight: 1.4,
    border: on ? "0.5px solid var(--c-text, #111)" : "0.5px solid color-mix(in srgb, var(--c-text, #111) 14%, transparent)",
    background: on ? "var(--c-text, #111)" : "color-mix(in srgb, var(--c-card, #fff) 55%, transparent)",
    color: on ? "var(--c-bg, #fff)" : "var(--c-text-secondary, #777)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
});

export const ghostBtn: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "5px 12px",
    borderRadius: 999,
    border: "0.5px solid color-mix(in srgb, var(--c-text, #111) 18%, transparent)",
    background: "color-mix(in srgb, var(--c-card, #fff) 55%, transparent)",
    color: "var(--c-text, #111)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
};

export const solidBtn: CSSProperties = {
    ...ghostBtn,
    border: "0.5px solid var(--c-text, #111)",
    background: "var(--c-text, #111)",
    color: "var(--c-bg, #fff)",
};

/** 小标签：核心准则 / 锚点 / 受保护 / 已放下 等状态 */
export const tag: CSSProperties = {
    display: "inline-block",
    padding: "0 7px",
    borderRadius: 999,
    fontSize: 10,
    lineHeight: "17px",
    border: "0.5px solid color-mix(in srgb, var(--c-text, #111) 22%, transparent)",
    color: "var(--c-text, #111)",
    whiteSpace: "nowrap",
};

export const barTrack: CSSProperties = { height: 4, borderRadius: 999, background: "color-mix(in srgb, var(--c-text, #111) 8%, transparent)", overflow: "hidden" };
export const barFill = (ratio: number): CSSProperties => ({ display: "block", height: "100%", width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`, background: "var(--c-text, #111)", borderRadius: 999, transition: "width .3s" });
