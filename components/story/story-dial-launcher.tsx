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

const ANGLE_STEP = 0.5;       // 相邻角色角间距（弧度）
const VISIBLE_HALF = 1.28;    // 单侧可见角度
const FOCUS_SCALE = 1.42;
const SCALE_FALL = 0.6;
const MIN_SCALE = 0.58;
const AVATAR_PX = 60;
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 320;

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
  const [showGroups, setShowGroups] = useState(false);

  const [f, setF] = useState(0);
  const fRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastFocusRef = useRef(0);
  const [pop, setPop] = useState<{ i: number; t: number } | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const modeRef = useRef<"single" | "build">("single");
  const selectedRef = useRef<string[]>([]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // 保存群组弹窗
  const [popupOpen, setPopupOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftPreset, setDraftPreset] = useState("");
  const [draftAvatar, setDraftAvatar] = useState("");

  const N = characters.length;

  useEffect(() => {
    const measure = () => {
      const el = containerRef.current;
      if (el) setSize({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const setFocus = useCallback((next: number, isDrag: boolean) => {
    const clamped = clamp(next, 0, Math.max(0, N - 1));
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
  }, [N]);

  const cancelRaf = () => { if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  const snapTo = useCallback((target: number) => {
    cancelRaf();
    const tgt = clamp(target, 0, Math.max(0, N - 1));
    const step = () => {
      const cur = fRef.current;
      const diff = tgt - cur;
      if (Math.abs(diff) < 0.001) { setFocus(tgt, false); rafRef.current = null; return; }
      setFocus(cur + diff * 0.22, false);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [N, setFocus]);
  useEffect(() => () => cancelRaf(), []);

  // 圆心在左边
  const pivotX = -size.w * 0.16;
  const pivotY = size.h * 0.5;
  const Rx = size.w * 0.66;
  const Ry = size.h * 0.38;
  const perItemPx = Ry * Math.sin(ANGLE_STEP) || 1;
  const discR = Rx + 48;              // 磨砂盘半径
  const interiorR = discR;            // 整个盘面（避开角色的判定交给 hitAvatar 优先）

  // 计算当前可见角色的屏幕位置，供命中测试
  const layoutRef = useRef<LayoutItem[]>([]);
  const detented = applyDetent(f);
  const focusIndex = Math.round(f);
  {
    const items: LayoutItem[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i - detented) * ANGLE_STEP;
      if (Math.abs(a) > VISIBLE_HALF + ANGLE_STEP) continue;
      const x = pivotX + Rx * Math.cos(a);
      const y = pivotY + Ry * Math.sin(a);
      const scale = clamp(FOCUS_SCALE - Math.abs(a) * SCALE_FALL, MIN_SCALE, FOCUS_SCALE);
      items.push({ id: characters[i].id, index: i, x, y, r: (AVATAR_PX * scale) / 2 + 12 });
    }
    layoutRef.current = items;
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
  const isInterior = (px: number, py: number) => {
    const dx = (px - pivotX) / 1;
    const dy = (py - pivotY) / 1;
    return Math.hypot(dx, dy) < interiorR;
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const openSavePopup = () => {
    setDraftName("");
    setDraftPreset("");
    setDraftAvatar("");
    setPopupOpen(true);
  };

  // 手势
  const gestureRef = useRef<{ startX: number; startY: number; startF: number; moved: boolean; interiorStart: boolean; }>(
    { startX: 0, startY: 0, startF: 0, moved: false, interiorStart: false });
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const tapTimer = useRef<number | null>(null);

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
    // 长按（只在圆盘内部、单人态触发建群）
    clearLongPress();
    if (interiorStart) {
      longPressTimer.current = window.setTimeout(() => {
        if (gestureRef.current.moved) return;
        longPressFired.current = true;
        try { navigator.vibrate?.(12); } catch { /* ignore */ }
        if (modeRef.current === "single") { setMode("build"); setSelected([]); }
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    const py = e.clientY - (rect?.top ?? 0);
    const px = e.clientX - (rect?.left ?? 0);
    const dy = py - g.startY;
    const dx = px - g.startX;
    if (!g.moved && Math.hypot(dx, dy) > 6) { g.moved = true; clearLongPress(); }
    if (g.moved) setFocus(g.startF - dy / perItemPx, true);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    clearLongPress();
    const g = gestureRef.current;
    setDragging(false);
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (g.moved) { snapTo(Math.round(fRef.current)); return; }

    // 纯点击
    const rect = containerRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    const hit = hitAvatar(px, py);

    if (hit) {
      if (modeRef.current === "build") { toggleSelected(hit.id); return; }
      if (hit.index === Math.round(fRef.current)) onOpenCharacter(hit.id);
      else snapTo(hit.index);
      return;
    }

    if (!isInterior(px, py)) return;

    // 圆盘内部空白
    if (modeRef.current === "build") {
      if (selectedRef.current.length >= 1) openSavePopup();
      else { setMode("single"); setSelected([]); }
      return;
    }
    // 单人态：单击圆盘内部无操作；双击 = 进入已有群组
    if (tapTimer.current != null) {
      window.clearTimeout(tapTimer.current); tapTimer.current = null;
      setShowGroups(true);
    } else {
      tapTimer.current = window.setTimeout(() => { tapTimer.current = null; }, DOUBLE_TAP_MS);
    }
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
    setSelected([]); // 保存后停留在建群页，清空以便继续选下一组
  };

  return (
    <div className="story-dial" ref={containerRef}>
      <div
        className="story-dial-disc"
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
        {characters.map((c, i) => {
          const a = (i - detented) * ANGLE_STEP;
          if (Math.abs(a) > VISIBLE_HALF + ANGLE_STEP) return null;
          const x = pivotX + Rx * Math.cos(a);
          const y = pivotY + Ry * Math.sin(a);
          const scale = clamp(FOCUS_SCALE - Math.abs(a) * SCALE_FALL, MIN_SCALE, FOCUS_SCALE);
          const opacity = Math.abs(a) > VISIBLE_HALF ? clamp(1 - (Math.abs(a) - VISIBLE_HALF) / ANGLE_STEP, 0, 1) : 1;
          const z = Math.round(120 - Math.abs(a) * 40);
          const isFocus = mode === "single" && i === focusIndex;
          const isSelected = mode === "build" && selected.includes(c.id);
          const popping = pop && pop.i === i && Date.now() - pop.t < 260;
          return (
            <div
              key={c.id}
              className={`story-dial-avatar${isFocus ? " is-focus" : ""}${isSelected ? " is-selected" : ""}${popping ? " is-pop" : ""}`}
              style={{
                left: x, top: y,
                transform: `translate(-50%, -50%) scale(${scale.toFixed(3)})`,
                opacity, zIndex: z,
                transition: dragging ? "none" : "transform 480ms cubic-bezier(.34,1.2,.32,1), opacity 320ms ease",
              }}
            >
              <span className="story-dial-avatar-inner">
                <Avatar src={c.avatar || undefined} name={c.name} size="lg" />
              </span>
              {(isFocus || isSelected) ? <span className="story-dial-avatar-name">{c.name}</span> : null}
            </div>
          );
        })}
      </div>

      {/* 提示条 */}
      <div className="story-dial-foot">
        {mode === "build"
          ? (selected.length >= 1
              ? `已选 ${selected.length} 人 · 点圆盘内部保存群组`
              : "点角色头像选人 · 点圆盘内部返回单人")
          : (N === 0 ? "还没有角色卡" : `点中间「${characters[focusIndex]?.name ?? ""}」开始 · 长按圆盘建群 · 双击圆盘进群组`)}
      </div>

      {/* 保存群组弹窗（黑白） */}
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

      {/* 已有群组（双击圆盘） */}
      {showGroups ? (
        <div className="story-dial-groups-overlay" onClick={() => setShowGroups(false)}>
          <div className="story-dial-groups-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="story-dial-groups-title">进入剧情群组</div>
            {groups.length === 0 ? (
              <div className="story-dial-groups-empty">还没有群组。长按圆盘内部进入建群，选好角色再点圆盘保存。</div>
            ) : (
              groups.map((g) => {
                const members = g.memberIds.map((id) => characters.find((c) => c.id === id)).filter(Boolean) as Character[];
                return (
                  <div key={g.id} className="story-dial-group-row" onClick={() => { setShowGroups(false); onOpenGroup(g.id); }}>
                    {g.avatar ? (
                      <div className="story-dial-group-cover"><img src={g.avatar} alt="" /></div>
                    ) : (
                      <div className="story-dial-group-avatars">
                        {members.slice(0, 4).map((c, i) => (
                          <div key={c.id} className="story-dial-group-ava" style={{ marginLeft: i === 0 ? 0 : -10, zIndex: 10 - i }}>
                            {c.avatar ? <img src={c.avatar} alt="" /> : <span>{c.name.trim().charAt(0) || "书"}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="story-dial-group-body">
                      <div className="story-dial-group-name">{g.name}</div>
                      <div className="story-dial-group-sub">{members.map((c) => c.name).join("、")}</div>
                    </div>
                    <span className="story-dial-group-edit" role="button" tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); setShowGroups(false); onEditGroup(g.id); }}>编辑</span>
                  </div>
                );
              })
            )}
            <button className="story-dial-groups-close" onClick={() => setShowGroups(false)}>关闭</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
