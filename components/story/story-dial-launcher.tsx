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
  onCreateGroup: (name: string, memberIds: string[], presetId: string) => void;
}

// 唱片盘几何参数（相对容器尺寸）
const ANGLE_STEP = 0.42;      // 相邻角色的角间距（弧度）
const VISIBLE_HALF = 1.32;    // 单侧可见角度上限
const FOCUS_SCALE = 1.5;
const SCALE_FALL = 0.62;
const MIN_SCALE = 0.6;

// 凹槽：把小数部分向整数聚拢，制造“卡进槽里”的手感
function applyDetent(f: number): number {
  const n = Math.floor(f);
  const t = f - n;
  const k = 0.24;
  return n + (t - (k * Math.sin(2 * Math.PI * t)) / (2 * Math.PI));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// 平滑蛇形路径（Catmull-Rom → 三次贝塞尔），避免生硬折线
function buildSnakePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  const d: string[] = [`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d.push(`C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
  }
  return d.join(" ");
}

export function StoryDialLauncher({
  characters, groups, presets,
  onOpenCharacter, onOpenGroup, onEditGroup, onCreateGroup,
}: StoryDialLauncherProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 390, h: 640 });
  const [mode, setMode] = useState<"dial" | "create">("dial");
  const [showGroups, setShowGroups] = useState(false);

  // 唱片盘当前焦点（小数）
  const [f, setF] = useState(0);
  const fRef = useRef(0);
  const dragRef = useRef<{ startY: number; startF: number; active: boolean; moved: boolean }>({ startY: 0, startF: 0, active: false, moved: false });
  const [dragging, setDragging] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastFocusRef = useRef(0);
  const [pop, setPop] = useState<{ i: number; t: number } | null>(null);

  // 群像创建态
  const [selected, setSelected] = useState<string[]>([]);
  const [presetId, setPresetId] = useState("");
  const [groupName, setGroupName] = useState("");

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

  const setFocus = useCallback((next: number) => {
    const clamped = clamp(next, 0, Math.max(0, N - 1));
    fRef.current = clamped;
    setF(clamped);
    const idx = Math.round(clamped);
    if (idx !== lastFocusRef.current) {
      lastFocusRef.current = idx;
      if (dragRef.current.active) {
        try { navigator.vibrate?.(6); } catch { /* ignore */ }
        setPop({ i: idx, t: Date.now() });
      }
    }
  }, [N]);

  const cancelRaf = () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  };

  // 松手/点击后弹到最近的槽（带轻微回弹）
  const snapTo = useCallback((target: number) => {
    cancelRaf();
    const tgt = clamp(target, 0, Math.max(0, N - 1));
    const step = () => {
      const cur = fRef.current;
      const diff = tgt - cur;
      if (Math.abs(diff) < 0.001) {
        setFocus(tgt);
        rafRef.current = null;
        return;
      }
      setFocus(cur + diff * 0.22);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [N, setFocus]);

  useEffect(() => () => cancelRaf(), []);

  // 唱片盘几何
  const pivotX = size.w * 1.02;
  const pivotY = size.h * 0.5;
  const Rx = size.w * 0.72;
  const Ry = size.h * 0.42;
  const perItemPx = Ry * Math.sin(ANGLE_STEP) || 1;

  const onPointerDown = (e: React.PointerEvent) => {
    if (mode !== "dial") return;
    cancelRaf();
    dragRef.current = { startY: e.clientY, startF: fRef.current, active: true, moved: false };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 4) d.moved = true;
    setFocus(d.startF - dy / perItemPx);
  };
  const endDrag = () => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    setDragging(false);
    snapTo(Math.round(fRef.current));
  };

  const focusIndex = Math.round(f);
  const detented = applyDetent(f);

  const enterCreate = useCallback(() => {
    setSelected([]);
    setPresetId("");
    setGroupName("");
    setMode("create");
  }, []);

  // 中心按钮：单击=选已有群组，双击=融化成线建群组
  const btnClickRef = useRef<number | null>(null);
  const onCenterButton = () => {
    if (btnClickRef.current != null) {
      window.clearTimeout(btnClickRef.current);
      btnClickRef.current = null;
      enterCreate();
      return;
    }
    btnClickRef.current = window.setTimeout(() => {
      btnClickRef.current = null;
      setShowGroups(true);
    }, 250);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // 蛇形线上的点
  const lineMargin = 52;
  const lineSpan = Math.max(size.w - lineMargin * 2, 1);
  const lineStep = N > 1 ? lineSpan / (N - 1) : 0;
  const linePoints = characters.map((_, i) => ({
    x: lineMargin + i * lineStep,
    y: size.h * 0.44 + Math.sin(i * 0.85 + 0.4) * size.h * 0.07,
  }));
  const snakePath = buildSnakePath(linePoints);

  return (
    <div className="story-dial" ref={containerRef}>
      {/* 磨砂唱片盘背景 */}
      <div
        className={`story-dial-disc${mode === "create" ? " is-melted" : ""}`}
        style={{
          left: pivotX - Rx * 1.18,
          top: pivotY - Ry * 1.18,
          width: Rx * 2.36,
          height: Ry * 2.36,
        }}
        aria-hidden="true"
      />

      {/* 蛇形连线（仅群像态） */}
      {mode === "create" ? (
        <svg className="story-dial-line-svg" width={size.w} height={size.h} aria-hidden="true">
          <path d={snakePath} className="story-dial-line-path" />
        </svg>
      ) : null}

      {/* 角色 */}
      <div
        className="story-dial-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {characters.map((c, i) => {
          let x: number, y: number, scale: number, opacity: number, z: number, hidden = false;
          if (mode === "dial") {
            const a = (i - detented) * ANGLE_STEP;
            if (Math.abs(a) > VISIBLE_HALF + ANGLE_STEP) hidden = true;
            x = pivotX - Rx * Math.cos(a);
            y = pivotY + Ry * Math.sin(a);
            scale = clamp(FOCUS_SCALE - Math.abs(a) * SCALE_FALL, MIN_SCALE, FOCUS_SCALE);
            opacity = Math.abs(a) > VISIBLE_HALF ? clamp(1 - (Math.abs(a) - VISIBLE_HALF) / ANGLE_STEP, 0, 1) : 1;
            z = Math.round(120 - Math.abs(a) * 40);
          } else {
            const p = linePoints[i];
            x = p.x; y = p.y; scale = 0.92; opacity = 1; z = 40;
          }
          if (hidden) return null;
          const isFocus = mode === "dial" && i === focusIndex;
          const isSelected = mode === "create" && selected.includes(c.id);
          const popping = pop && pop.i === i && Date.now() - pop.t < 260;
          return (
            <button
              key={c.id}
              className={`story-dial-avatar${isFocus ? " is-focus" : ""}${isSelected ? " is-selected" : ""}${popping ? " is-pop" : ""}`}
              style={{
                left: x,
                top: y,
                transform: `translate(-50%, -50%) scale(${scale.toFixed(3)})`,
                opacity,
                zIndex: z,
                transition: dragging && mode === "dial"
                  ? "none"
                  : `transform 620ms cubic-bezier(.34,1.2,.32,1) ${mode === "create" ? i * 45 : 0}ms, opacity 400ms ease`,
              }}
              onClick={() => {
                if (dragRef.current.moved) return;
                if (mode === "dial") {
                  if (i === focusIndex) onOpenCharacter(c.id);
                  else snapTo(i);
                } else {
                  toggleSelected(c.id);
                }
              }}
            >
              <span className="story-dial-avatar-inner">
                <Avatar src={c.avatar || undefined} name={c.name} size="lg" />
              </span>
              {(isFocus || isSelected) ? <span className="story-dial-avatar-name">{c.name}</span> : null}
            </button>
          );
        })}
      </div>

      {/* 中心按钮（唱片轴心） */}
      {mode === "dial" ? (
        <button className="story-dial-center-btn" onClick={onCenterButton}>
          <span className="story-dial-center-dot" />
          <span className="story-dial-center-label">群组</span>
          <span className="story-dial-center-hint">单击选群 · 双击建群</span>
        </button>
      ) : null}

      {/* 单人态底部提示 */}
      {mode === "dial" ? (
        <div className="story-dial-foot">
          {N === 0 ? "还没有角色卡" : `滑动转盘 · 点中间的「${characters[focusIndex]?.name ?? ""}」开始`}
        </div>
      ) : null}

      {/* 群像创建底部面板 */}
      {mode === "create" ? (
        <div className="story-dial-sheet">
          <div className="story-dial-sheet-row">
            <input
              className="story-dial-name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="群组名称（可留空）"
            />
            <button className="story-dial-sheet-back" onClick={() => setMode("dial")}>返回转盘</button>
          </div>
          <div className="story-dial-preset-label">预设</div>
          <div className="story-dial-presets">
            <button
              className="story-dial-preset-chip"
              data-active={!presetId ? "true" : undefined}
              onClick={() => setPresetId("")}
            >跟随默认</button>
            {presets.map((p) => (
              <button
                key={p.id}
                className="story-dial-preset-chip"
                data-active={presetId === p.id ? "true" : undefined}
                onClick={() => setPresetId(p.id)}
              >{p.name}</button>
            ))}
          </div>
          <button
            className="story-dial-create-btn"
            disabled={selected.length < 2}
            onClick={() => onCreateGroup(groupName, selected, presetId)}
          >
            {selected.length < 2 ? "至少选 2 个角色" : `创建并开始（${selected.length} 人）`}
          </button>
        </div>
      ) : null}

      {/* 已有群组选择面板（单击中心按钮） */}
      {showGroups ? (
        <div className="story-dial-groups-overlay" onClick={() => setShowGroups(false)}>
          <div className="story-dial-groups-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="story-dial-groups-title">进入剧情群组</div>
            {groups.length === 0 ? (
              <div className="story-dial-groups-empty">还没有群组。双击中间的「群组」按钮，把几个角色连成一条线来创建。</div>
            ) : (
              groups.map((g) => {
                const members = g.memberIds.map((id) => characters.find((c) => c.id === id)).filter(Boolean) as Character[];
                return (
                  <div key={g.id} className="story-dial-group-row" onClick={() => { setShowGroups(false); onOpenGroup(g.id); }}>
                    <div className="story-dial-group-avatars">
                      {members.slice(0, 4).map((c, i) => (
                        <div key={c.id} className="story-dial-group-ava" style={{ marginLeft: i === 0 ? 0 : -10, zIndex: 10 - i }}>
                          {c.avatar ? <img src={c.avatar} alt="" /> : <span>{c.name.trim().charAt(0) || "书"}</span>}
                        </div>
                      ))}
                    </div>
                    <div className="story-dial-group-body">
                      <div className="story-dial-group-name">{g.name}</div>
                      <div className="story-dial-group-sub">{members.map((c) => c.name).join("、")}</div>
                    </div>
                    <span
                      className="story-dial-group-edit"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); setShowGroups(false); onEditGroup(g.id); }}
                    >编辑</span>
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
