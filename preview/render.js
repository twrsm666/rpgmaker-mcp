import { getBundle, drawMap, drawPalette } from "/renderer.js";
try {
  const params = new URLSearchParams(location.search), token = params.get("token");
  const spec = JSON.parse(params.get("spec"));
  const bundle = await getBundle(spec.mapId, token);
  const draw = spec.mode === "palette" ? drawPalette : drawMap;
  window.renderMeta = await draw(document.getElementById("render"), bundle, token, spec);
  window.renderDone = true;
} catch (error) { window.renderError = error.message; }
