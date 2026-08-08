export const RIGHT_PANEL_MIN_WIDTH = 220;
export const RIGHT_PANEL_MAX_WIDTH = 520;
export const RIGHT_PANEL_RESIZE_STEP = 16;
export const RIGHT_PANEL_GUTTER_WIDTH = 8;
export const RIGHT_PANEL_DIVIDER_HIT_WIDTH = RIGHT_PANEL_GUTTER_WIDTH;

export function clampRightPanelWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) return RIGHT_PANEL_MIN_WIDTH;
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, width));
}

export function resizeRightPanelFromPointer(startWidth, startClientX, clientX) {
  const delta = Number(startClientX) - Number(clientX);
  return clampRightPanelWidth(Number(startWidth) + (Number.isFinite(delta) ? delta : 0));
}

export function resizeRightPanelWithKey(width, key) {
  if (key === 'ArrowLeft') return clampRightPanelWidth(Number(width) + RIGHT_PANEL_RESIZE_STEP);
  if (key === 'ArrowRight') return clampRightPanelWidth(Number(width) - RIGHT_PANEL_RESIZE_STEP);
  return null;
}

export function rightPanelDividerGeometry(viewportWidth, panelWidth) {
  const viewport = Math.max(0, Number(viewportWidth) || 0);
  const panel = Math.max(0, Math.min(viewport, Number(panelWidth) || 0));
  const gutterWidth = Math.min(panel, RIGHT_PANEL_GUTTER_WIDTH);
  const hitWidth = Math.min(gutterWidth, RIGHT_PANEL_DIVIDER_HIT_WIDTH);
  const lineX = viewport - panel;
  return {
    lineX,
    hitLeft: lineX,
    hitRight: lineX + hitWidth,
    hitWidth,
    gutterLeft: lineX,
    gutterRight: lineX + gutterWidth,
    gutterWidth,
    contentLeft: lineX + gutterWidth,
  };
}
