// Runs the Wi-Fi cabling design off the page's main thread. The worker lives as long
// as the page, so its routing cache survives between calculations: after the first
// one, a small change (an AP or a rack moved) is quick.
import { designWifiCabling } from "./design.js";

self.onmessage = (event) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, design: designWifiCabling(input) });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
