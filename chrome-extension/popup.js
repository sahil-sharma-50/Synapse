const element = (id) => document.getElementById(id);
element("command").value =
  `powershell -ExecutionPolicy Bypass -File .\\chrome-extension\\register.ps1 -ExtensionId ${chrome.runtime.id}`;
async function refresh(action = "status") {
  try {
    const result = await chrome.runtime.sendMessage({ action });
    const missing = /native messaging host not found|registration missing/i.test(
      result.error || "",
    );
    element("status").textContent = result.connected
      ? result.working
        ? "Task running"
        : "Connected to Synapse"
      : missing
        ? "Setup needed"
        : result.connecting
          ? "Connecting…"
          : "Synapse unavailable";
    element("indicator").dataset.state = result.connected ? "connected" : "disconnected";
    element("description").textContent = result.connected
      ? result.working
        ? "Chrome is carrying out your request. You can stop it at any time."
        : "Ready for browser tasks from your AI panel."
      : missing
        ? "Chrome cannot find the Synapse native helper. Register it once to connect."
        : result.connecting
          ? "Waiting for the desktop app."
          : "Keep Synapse running and enable Chrome control in Settings → AI, then reconnect.";
    element("setup").hidden = !missing;
    element("diagnostic").hidden = result.connected || !result.error;
    element("error").textContent = result.error || "";
    element("stop").disabled = !result.working;
    element("reconnect").disabled = !!result.connecting;
  } catch {
    element("status").textContent = "Extension unavailable";
    element("description").textContent =
      "Reload the extension in chrome://extensions, then reopen this popup.";
    element("stop").disabled = true;
  }
}
element("reconnect").onclick = () => void refresh("reconnect");
element("stop").onclick = () => void refresh("stop");
element("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(element("command").value);
    element("copy").textContent = "Copied";
  } catch {
    element("command").focus();
    element("command").select();
    element("copy").textContent = "Select and copy the command";
  }
};
chrome.storage.onChanged.addListener(() => void refresh());
void refresh();
