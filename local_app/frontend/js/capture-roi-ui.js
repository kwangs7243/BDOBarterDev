import { displayedVideoContentRect, moveNormalizedRegion, normalizeRegion, resizeNormalizedRegion } from "./capture.js";

export function initCaptureRoiUI({ video, stage, box, getRegion, setRegion, isVisible, canInteract }) {
  const events = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: events.signal });
  const render = () => {
    const content = displayedVideoContentRect(video, stage);
    box.hidden = !content || !isVisible();
    if (box.hidden) return;
    const region = normalizeRegion(getRegion());
    setRegion(region);
    const bounds = stage.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${content.left - bounds.left + region.x * content.width}px`,
      top: `${content.top - bounds.top + region.y * content.height}px`,
      width: `${region.width * content.width}px`,
      height: `${region.height * content.height}px`,
    });
    box.dataset.normalized = JSON.stringify(region);
  };
  listen(box, "pointerdown", (event) => {
    if (!canInteract()) return;
    const content = displayedVideoContentRect(video, stage);
    const handle = event.target.closest("[data-roi-handle]")?.dataset.roiHandle;
    if (!content || (!handle && !event.target.closest("[data-roi-move]"))) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, region: { ...getRegion() } };
    const minimumWidth = Math.min(0.95, 80 / content.width);
    const minimumHeight = Math.min(0.95, 60 / content.height);
    try { event.target.setPointerCapture?.(event.pointerId); } catch {}
    const move = (next) => {
      const dx = (next.clientX - start.x) / content.width;
      const dy = (next.clientY - start.y) / content.height;
      setRegion(handle
        ? resizeNormalizedRegion(start.region, handle, dx, dy, minimumWidth, minimumHeight)
        : moveNormalizedRegion(start.region, dx, dy, minimumWidth, minimumHeight));
      render();
    };
    const finish = () => {
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", finish);
      box.removeEventListener("pointercancel", finish);
    };
    listen(box, "pointermove", move);
    listen(box, "pointerup", finish, { once: true });
    listen(box, "pointercancel", finish, { once: true });
  });
  listen(video, "resize", render);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(render) : null;
  observer?.observe(stage);
  const dispose = () => {
    events.abort();
    observer?.disconnect();
  };
  return { render, dispose };
}
