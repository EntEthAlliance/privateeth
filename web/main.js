// Router. Everything runs in this tab: no backend.
//   #            landing (animated preview, ways in)
//   #setup       set up a live demo with MetaMask
//   #console     the whole story on one screen
//   #watch       what everyone can see on the chain (no keys)
//   #bank-a, #bank-b, #regulator   single-role screens
//   #setup=…, #watch=…             links that carry a role or a public view
import { $ } from "./app/util.js";
import { takeLinkFromHash, loadProfiles, validateProfile, loadWatch } from "./app/profiles.js";
import { showLanding, stopPreview } from "./app/landing.js";
import { showSetup, installProfiles, loadAdmin } from "./app/setup.js";
import { showConsole } from "./app/console.js";
import { showWatch, resetWatchPaint } from "./app/watch.js";
import { showRole, leaveRole } from "./app/roles.js";

function route() {
  const error = takeLinkFromHash();
  const id = location.hash.slice(1);
  stopPreview(); leaveRole(); resetWatchPaint();
  $("#app").dataset.role = "";
  $("#toast").hidden = true;
  if (id === "setup") return showSetup();
  if (id === "watch") return showWatch(loadWatch());
  let profiles = loadProfiles();
  // The setup page's session is usable on this device even if its roles were forgotten.
  if ((id === "console" || id === "bank-a" || id === "bank-b" || id === "regulator") && !profiles[id]) { installProfiles(loadAdmin()); profiles = loadProfiles(); }
  let prof = null;
  if (profiles[id]) { try { prof = validateProfile(profiles[id]); } catch { prof = null; } }
  if (prof?.role === "console") return showConsole(prof);
  if (prof) return showRole(prof);
  showLanding(error);
}
window.addEventListener("hashchange", route);
route();
