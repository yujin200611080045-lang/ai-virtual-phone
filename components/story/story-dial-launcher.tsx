"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/primitives";
import type { Character } from "@/lib/character-types";
import type { StoryGroup } from "@/lib/story-storage";

type PresetOption = { id: string; name: string };

interface StoryDialLauncherProps {
  characters: Character[];
  groups: StoryGroup[];
  presets: PresetOption[];
  onOpenCharacter: (id: string) => void;
  onOpenGroup: (id: string) => void;
  onEditGroup: (id: string) => void;
  onSaveGroup: (name: string, memberIds: string[], presetId: string, avatar: string) => void;
}

const ANGLE_STEP = 0.48;
const VISIBLE_HALF = 1.12;
const FOCUS_SCALE = 1.42;
const SCALE_FALL = 0.6;
const MIN_SCALE = 0.58;
const AVATAR_PX = 60;
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 320;

type DialItem = { id: string; name: string; avatarUrl?: string };

function applyDetent(f: number): number {
  const n = Math.floor(f);
  const t = f - n;
  const k = 0.24;
  return n + (t - (k * Math.sin(2 * Math.PI * t)) / (2 * Math.PI));
}
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

type LayoutItem = { id: string; index: number; x: number; y: number; r: number };

export function StoryDialLauncher({
  characters, groups, presets,
  onOpenCharacter, onOpenGroup, onEditGroup, onSaveGroup,
}: StoryDialLauncherProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 390, h: 640 });
  const [mode, setMode] = useState<"single" | "build">("single");
  const [deck, setDeck] = useState<"chars" | "groups">("chars");   // 单人态：角色盘 / 群组盘

  const [f, setF] = useState(0);
  const fRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastFocusRef = useRef(0);
  const [pop, setPop] = useState<{ i: number; t: number } | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const modeRef = useRef<"single" | "build">("single");
  const deckRef = useRef<"chars" | "groups">("chars");
  const selectedRef = useRef<string[]>([]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { deckRef.current = deck; }, [deck]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const [popupOpen, setPopupOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftPreset, setDraftPreset] = useState("");
  const [draftAvatar, setDraftAvatar] = useState("");

  // 当前盘上的条目：建群或角色盘=角色；群组盘=群组
  const charItems: DialItem[] = characters.map((c) => ({ id: c.id, name: c.name, avatarUrl: c.avatar || undefined }));
  const groupItems: DialItem[] = groups.map((g) => ({ id: g.id, name: g.name, avatarUrl: g.avatar || undefined }));
  const inGroupsDeck = mode === "single" && deck === "groups";
  const items: DialItem[] = inGroupsDeck ? groupItems : charItems;
  const M = items.length;

  useEffect(() => {
    const measure = () => {
      const el = containerRef.current;
      if (el) setSize({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const resetFocus = useCallback(() => {
    fRef.current = 0; lastFocusRef.current = 0; setF(0);
  }, []);

  const setFocus = useCallback((next: number, isDrag: boolean) => {
    const clamped = clamp(next, 0, Math.max(0, M - 1));
    fRef.current = clamped;
    setF(clamped);
    const idx = Math.round(clamped);
    if (idx !== lastFocusRef.current) {
      lastFocusRef.current = idx;
      if (isDrag) {
        try { navigator.vibrate?.(6); } catch { /* ignore */ }
        setPop({ i: idx, t: Date.now() });
      }
    }
  }, [M]);

  const cancelRaf = () => { if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  const snapTo = useCallback((target: number) => {
    cancelRaf();
    const tgt = clamp(target, 0, Math.max(0, M - 1));
    const step = () => {
      const cur = fRef.current;
      const diff = tgt - cur;
      if (Math.abs(diff) < 0.001) { setFocus(tgt, false); rafRef.current = null; return; }
      setFocus(cur + diff * 0.22, false);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [M, setFocus]);
  useEffect(() => () => cancelRaf(), []);

  // 圆心贴左边缘
  const pivotX = -size.w * 0.04;
  const pivotY = size.h * 0.53;
  const Rx = size.w * 0.62;
  const Ry = size.h * 0.4;
  const perItemPx = Ry * Math.sin(ANGLE_STEP) || 1;
  const discR = Math.max(Rx, Ry) + 42;
  const interiorR = Rx * 0.72;

  const layoutRef = useRef<LayoutItem[]>([]);
  const focusIdRef = useRef<string>("");
  const detented = applyDetent(f);
  const focusIndex = Math.round(f);
  focusIdRef.current = items[focusIndex]?.id ?? "";
  {
    const list: LayoutItem[] = [];
    for (let i = 0; i < M; i++) {
      const a = (i - detented) * ANGLE_STEP;
      if (Math.abs(a) > VISIBLE_HALF + ANGLE_STEP) continue;
      const x = pivotX + Rx * Math.cos(a);
      const y = pivotY + Ry * Math.sin(a);
      const scale = clamp(FOCUS_SCALE - Math.abs(a) * SCALE_FALL, MIN_SCALE, FOCUS_SCALE);
      list.push({ id: items[i].id, index: i, x, y, r: (AVATAR_PX * scale) / 2 + 12 });
    }
    layoutRef.current = list;
  }

  const hitAvatar = (px: number, py: number): LayoutItem | null => {
    let best: LayoutItem | null = null;
    let bestD = Infinity;
    for (const it of layoutRef.current) {
      const d = Math.hypot(px - it.x, py - it.y);
      if (d < it.r && d < bestD) { best = it; bestD = d; }
    }
    return best;
  };
  const isInterior = (px: number, py: number) => Math.hypot(px - pivotX, py - pivotY) < interiorR;

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const openSavePopup = () => { setDraftName(""); setDraftPreset(""); setDraftAvatar(""); setPopupOpen(true); };

  const enterBuild = () => { setMode("build"); setDeck("chars"); setSelected([]); resetFocus(); };
  const exitToSingle = () => { setMode("single"); setDeck("chars"); setSelected([]); resetFocus(); };
  const toggleDeck = () => { setDeck((d) => (d === "chars" ? "groups" : "chars")); resetFocus(); };

  const gestureRef = useRef<{ startX: number; startY: number; startF: number; moved: boolean; interiorStart: boolean }>(
    { startX: 0, startY: 0, startF: 0, moved: false, interiorStart: false });
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const lastInteriorTap = useRef(0);
  const clearLongPress = () => { if (longPressTimer.current != null) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; } };

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    cancelRaf();
    longPressFired.current = false;
    const interiorStart = isInterior(px, py) && !hitAvatar(px, py);
    gestureRef.current = { startX: px, startY: py, startF: fRef.current, moved: false, interiorStart };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    clearLongPress();
    if (interiorStart) {
      longPressTimer.current = window.setTimeout(() => {
        if (gestureRef.current.moved) return;
        longPressFired.current = true;
        try { navigator.vibrate?.(12); } catch { /* ignore */ }
        if (modeRef.current === "single") {
          if (deckRef.current === "chars") enterBuild();
          else if (focusIdRef.current) onEditGroup(focusIdRef.current); // 群组盘长按=编辑当前居中的群组
        }
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    const dx = px - g.startX;
    const dy = py - g.startY;
    if (!g.moved && Math.hypot(dx, dy) > 6) { g.moved = true; clearLongPress(); }
    if (g.moved) setFocus(g.startF - dy / perItemPx, true);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    clearLongPress();
    const g = gestureRef.current;
    setDragging(false);
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (g.moved) { snapTo(Math.round(fRef.current)); return; }

    const rect = containerRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    const hit = hitAvatar(px, py);
    const fi = Math.round(fRef.current);

    if (hit) {
      if (modeRef.current === "build") { toggleSelected(hit.id); return; }
      if (hit.index !== fi) { snapTo(hit.index); return; }
      if (deckRef.current === "groups") onOpenGroup(hit.id);
      else onOpenCharacter(hit.id);
      return;
    }

    if (!isInterior(px, py)) return;

    if (modeRef.current === "build") {
      if (selectedRef.current.length >= 1) openSavePopup();
      else exitToSingle();
      return;
    }
    // 单人态：双击圆盘内部 = 切换角色盘/群组盘
    const now = Date.now();
    if (now - lastInteriorTap.current < DOUBLE_TAP_MS) { lastInteriorTap.current = 0; toggleDeck(); }
    else { lastInteriorTap.current = now; }
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setDraftAvatar(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  };
  const confirmSave = () => {
    if (selected.length < 2) return;
    onSaveGroup(draftName, selected, draftPreset, draftAvatar);
    setPopupOpen(false);
    setSelected([]);
  };

  const focusName = items[focusIndex]?.name ?? "";

  return (
    <div className="story-dial" ref={containerRef}>
      <div
        className={`story-dial-disc${inGroupsDeck ? " is-groups" : ""}`}
        style={{ left: pivotX - discR, top: pivotY - discR, width: discR * 2, height: discR * 2 }}
        aria-hidden="true"
      />

      <div
        className="story-dial-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { clearLongPress(); setDragging(false); }}
      >
        {items.map((it, i) => {
          const a = (i - detented) * ANGLE_STEP;
          if (Math.abs(a) > VISIBLE_HALF + ANGLE_STEP) return null;
          const x = pivotX + Rx * Math.cos(a);
          const y = pivotY + Ry * Math.sin(a);
          const scale = clamp(FOCUS_SCALE - Math.abs(a) * SCALE_FALL, MIN_SCALE, FOCUS_SCALE);
          const opacity = Math.abs(a) > VISIBLE_HALF ? clamp(1 - (Math.abs(a) - VISIBLE_HALF) / ANGLE_STEP, 0, 1) : 1;
          const z = Math.round(120 - Math.abs(a) * 40);
          const isFocus = mode === "single" && i === focusIndex;
          const isSelected = mode === "build" && selected.includes(it.id);
          const popping = pop && pop.i === i && Date.now() - pop.t < 260;
          return (
            <div
              key={it.id}
              className={`story-dial-avatar${isFocus ? " is-focus" : ""}${isSelected ? " is-selected" : ""}${popping ? " is-pop" : ""}${inGroupsDeck ? " is-group" : ""}`}
              style={{
                left: x, top: y,
                transform: `translate(-50%, -50%) scale(${scale.toFixed(3)})`,
                opacity, zIndex: z,
                transition: dragging ? "none" : "transform 480ms cubic-bezier(.34,1.2,.32,1), opacity 320ms ease",
              }}
            >
              <span className="story-dial-avatar-inner">
                <Avatar src={it.avatarUrl} name={it.name} size="lg" />
              </span>
              {(isFocus || isSelected) ? <span className="story-dial-avatar-name">{it.name}</span> : null}
            </div>
          );
        })}
      </div>

      {/* 空盘提示 */}
      {inGroupsDeck && M === 0 ? (
        <div className="story-dial-empty-groups">还没有群组<br />双击圆盘回角色盘 · 长按圆盘建群</div>
      ) : null}

      <div className="story-dial-foot">
        {mode === "build"
          ? (selected.length >= 1 ? `已选 ${selected.length} 人 · 点圆盘内部保存群组` : "点角色头像选人 · 点圆盘内部返回单人")
          : inGroupsDeck
            ? (M === 0 ? "群组盘（空）· 双击圆盘回角色盘" : `群组盘 · 点中间「${focusName}」进剧情 · 双击回角色盘`)
            : (M === 0 ? "还没有角色卡" : `点中间「${focusName}」开始 · 长按圆盘建群 · 双击圆盘看群组`)}
      </div>

      {popupOpen ? (
        <div className="story-modal-overlay" onClick={() => setPopupOpen(false)}>
          <div className="story-group-modal" onClick={(e) => e.stopPropagation()}>
            <div className="story-group-modal-title">新建剧情群组（{selected.length} 人）</div>
            <div className="story-dial-avatar-pick">
              <label className="story-dial-avatar-drop">
                {draftAvatar ? <img src={draftAvatar} alt="" /> : <span>＋<br />头像</span>}
                <input type="file" accept="image/*" onChange={onFilePick} hidden />
              </label>
              <input
                className="story-group-modal-input"
                style={{ flex: 1 }}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="群组名称"
              />
            </div>
            <label className="story-group-modal-label">预设</label>
            <div className="story-group-modal-lead">
              <button className="story-group-modal-lead-chip" data-active={!draftPreset ? "true" : undefined} onClick={() => setDraftPreset("")}>跟随默认</button>
              {presets.map((p) => (
                <button key={p.id} className="story-group-modal-lead-chip" data-active={draftPreset === p.id ? "true" : undefined} onClick={() => setDraftPreset(p.id)}>{p.name}</button>
              ))}
            </div>
            <div className="story-group-modal-actions">
              <span />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="story-group-modal-btn" onClick={() => setPopupOpen(false)}>取消</button>
                <button className="story-group-modal-btn story-group-modal-primary" onClick={confirmSave}>保存</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
