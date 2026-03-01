const SIDEBAR_DEFAULT_WIDTH = 320;

export function initResizer() {
  const resizer = document.getElementById("sidebar-resizer");
  const app = document.querySelector(".app");
  if (!resizer || !app) return;

  let startX = 0;
  let startWidth = 0;
  let rafPending = false;
  let pendingWidth = 0;

  resizer.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startWidth = parseInt(
      getComputedStyle(app).getPropertyValue("--sidebar-width") ||
        String(SIDEBAR_DEFAULT_WIDTH),
      10,
    );
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    e.preventDefault();
  });

  resizer.addEventListener("pointermove", (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    pendingWidth = Math.max(
      100,
      Math.min(startWidth + (e.clientX - startX), window.innerWidth - 200),
    );
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        app.style.setProperty("--sidebar-width", pendingWidth + "px");
        rafPending = false;
      });
    }
  });

  function stopDrag(e) {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    resizer.classList.remove("dragging");
  }

  resizer.addEventListener("pointerup", stopDrag);
  resizer.addEventListener("pointercancel", stopDrag);

  resizer.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 50 : 10;
    let currentWidth = parseInt(
      getComputedStyle(app).getPropertyValue("--sidebar-width") ||
        String(SIDEBAR_DEFAULT_WIDTH),
      10,
    );
    if (e.key === "ArrowLeft") {
      currentWidth = Math.max(100, currentWidth - step);
    } else if (e.key === "ArrowRight") {
      currentWidth = Math.min(window.innerWidth - 200, currentWidth + step);
    } else {
      return;
    }
    e.preventDefault();
    app.style.setProperty("--sidebar-width", currentWidth + "px");
  });
}
