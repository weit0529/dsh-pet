import { HIT_BOX } from '../client/constants.ts';
import type { Corner } from '../client/types';

export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowDimensions {
  width: number;
  height: number;
  videoHeight: number;
  bubble: number;
}

/** 桌宠本体相对透明原生窗口左上角的可见边界。 */
export interface PetVisualOffsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WindowOriginRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function desktopWindowDimensions(size: number): DesktopWindowDimensions {
  const width = Math.max(120, Math.round(size));
  const videoHeight = Math.round((width * 9) / 16);
  const bubble = Math.max(96, Math.round(width * 0.32));
  return { width, height: videoHeight + bubble, videoHeight, bubble };
}

/**
 * Electron 窗口包含大量透明画布和上方气泡预留区。桌面边界应约束宠物本体，
 * 而不是整个透明窗口，否则人物永远无法走到屏幕四周。
 */
export function petVisualOffsets(size: number): PetVisualOffsets {
  const dim = desktopWindowDimensions(size);
  return {
    left: (dim.width * HIT_BOX.x0) / 640,
    top: dim.bubble + (dim.videoHeight * HIT_BOX.y0) / 360,
    right: (dim.width * HIT_BOX.x1) / 640,
    bottom: dim.bubble + (dim.videoHeight * HIT_BOX.y1) / 360,
  };
}

function safeAxisRange(min: number, max: number): { min: number; max: number } {
  const integerMin = Math.ceil(min);
  const integerMax = Math.floor(max);
  if (integerMin <= integerMax) return { min: integerMin, max: integerMax };
  // 极端尺寸下本体大于可用区域，无法完全容纳时固定在居中位置。
  const center = Math.round((min + max) / 2);
  return { min: center, max: center };
}

/** 原生窗口左上角允许移动的范围；透明部分可越界，可见宠物本体不可越界。 */
export function windowOriginRange(area: DesktopRect, size: number, margin = 0): WindowOriginRange {
  const visual = petVisualOffsets(size);
  const safeMargin = Math.max(0, margin);
  const x = safeAxisRange(area.x + safeMargin - visual.left, area.x + area.width - safeMargin - visual.right);
  const y = safeAxisRange(area.y + safeMargin - visual.top, area.y + area.height - safeMargin - visual.bottom);
  return { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max };
}

export function clampWindowOrigin(
  area: DesktopRect,
  size: number,
  x: number,
  y: number,
  margin = 0,
): { x: number; y: number } {
  const range = windowOriginRange(area, size, margin);
  return {
    x: Math.round(Math.min(Math.max(x, range.minX), range.maxX)),
    y: Math.round(Math.min(Math.max(y, range.minY), range.maxY)),
  };
}

export function initialWindowOrigin(
  area: DesktopRect,
  size: number,
  corner: Corner,
  marginX: number,
  marginY: number,
): { x: number; y: number } {
  const visual = petVisualOffsets(size);
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');
  const x = right ? area.x + area.width - marginX - visual.right : area.x + marginX - visual.left;
  const y = bottom ? area.y + area.height - marginY - visual.bottom : area.y + marginY - visual.top;
  return clampWindowOrigin(area, size, x, y);
}
